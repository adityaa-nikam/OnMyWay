const { haversineDistanceMeters, locationSharingService } = require('./locationSharing');
const { repo } = require('../db');

/**
 * Average driving speed for straight-line ETA fallback:
 * 40 km/h = ~11.11 meters/second
 */
const DEFAULT_FALLBACK_SPEED_MPS = 11.11;
const CACHE_TTL_MS = 45 * 1000; // 45 seconds cache TTL
const MOVEMENT_THRESHOLD_METERS = 100; // Recompute only after > 100m movement
const ARRIVAL_THRESHOLD_METERS = 100; // Destination geofence radius
const LATENESS_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes grace after meetup start

class RoutingService {
  constructor() {
    this.cache = new Map(); // key: `${meetupId}:${userId}` -> { etaSeconds, etaTimestamp, distanceMeters, polyline, isApproximate, computedAt, lat, lng }
    this.sweepInterval = null;
    this.io = null;
  }

  init(io) {
    this.io = io;
    // Auto-end sweep for expired meetups (runs every 60s)
    this.sweepInterval = setInterval(() => {
      this.sweepExpiredMeetups();
    }, 60 * 1000);

    if (this.sweepInterval.unref) {
      this.sweepInterval.unref();
    }
  }

  /**
   * Calculate straight-line fallback route (always available offline / without external APIs)
   */
  calculateStraightLineRoute(fromLat, fromLng, toLat, toLng) {
    const distanceMeters = Math.round(haversineDistanceMeters(fromLat, fromLng, toLat, toLng));
    const etaSeconds = Math.max(1, Math.round(distanceMeters / DEFAULT_FALLBACK_SPEED_MPS));
    return {
      distanceMeters,
      etaSeconds,
      polyline: [
        [fromLat, fromLng],
        [toLat, toLng]
      ],
      isApproximate: true
    };
  }

  /**
   * Fetch route from OSRM provider if OSRM_BASE_URL is configured.
   * Public OSRM demo is NOT for production as it leaks coordinates.
   * Strict 2500ms timeout prevents hanging; falls back to straight line on error/timeout.
   */
  async fetchOsrmRoute(fromLat, fromLng, toLat, toLng, timeoutMs = 2500) {
    const baseUrl = process.env.OSRM_BASE_URL;
    if (!baseUrl || !baseUrl.trim()) {
      return null; // OSRM not configured; fall back to straight line
    }

    const cleanBase = baseUrl.trim().replace(/\/$/, '');
    const url = `${cleanBase}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[RoutingService] OSRM returned HTTP ${response.status}. Falling back to straight-line.`);
        return null;
      }

      const data = await response.json();
      if (!data.routes || data.routes.length === 0) {
        return null;
      }

      const route = data.routes[0];
      const polyline = (route.geometry && route.geometry.coordinates)
        ? route.geometry.coordinates.map(([lng, lat]) => [lat, lng])
        : [[fromLat, fromLng], [toLat, toLng]];

      return {
        distanceMeters: Math.round(route.distance),
        etaSeconds: Math.round(route.duration),
        polyline,
        isApproximate: false
      };
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[RoutingService] OSRM fetch failed or timed out (${err.message}). Falling back to straight-line.`);
      return null;
    }
  }

  /**
   * Compute or return cached ETA for a user attending a meetup.
   * Strictly enforces:
   * 1. 45-second cache window
   * 2. > 100m movement requirement before recalculating
   * 3. Non-participant check (RSVP != 'no' and membership verified)
   * 4. Geofence arrival detection and optional stop_on_arrival
   * 5. Lateness flag (ETA > start_time + grace)
   */
  async computeUserEta(meetupId, userId, userLat, userLng) {
    const meetup = repo.getMeetupById(meetupId);
    if (!meetup || meetup.status === 'ended') {
      return null;
    }

    // 1. Verify user RSVP & participation
    const rsvp = repo.getMeetupRsvp(meetupId, userId);
    if (!rsvp || rsvp.rsvp === 'no') {
      // Non-participants receive no ETAs and generate no ETAs
      return null;
    }

    const destLat = meetup.destination.lat;
    const destLng = meetup.destination.lng;
    const now = Date.now();
    const cacheKey = `${meetupId}:${userId}`;

    // 2. Check destination arrival geofence
    const currentDistance = haversineDistanceMeters(userLat, userLng, destLat, destLng);
    const isArrived = currentDistance <= ARRIVAL_THRESHOLD_METERS;

    if (isArrived && !rsvp.arrived_at) {
      repo.markMeetupArrived(meetupId, userId, now);
      rsvp.arrived_at = now;

      // If meetup has stop_on_arrival enabled, stop active share immediately
      if (meetup.stop_on_arrival) {
        locationSharingService.stopShare(userId, 'arrived');
      }

      if (this.io) {
        this.io.to(meetup.group_id).emit('meetup:arrived', {
          meetupId,
          userId,
          userName: rsvp.user_name || 'Participant',
          arrivedAt: now
        });
      }
    }

    // 3. Check Cache: valid for 45s unless moved > 100m
    const cached = this.cache.get(cacheKey);
    let routeInfo = null;

    if (cached) {
      const cacheAgeMs = now - cached.computedAt;
      const movedMeters = haversineDistanceMeters(userLat, userLng, cached.lat, cached.lng);

      if (cacheAgeMs < CACHE_TTL_MS && movedMeters <= MOVEMENT_THRESHOLD_METERS) {
        routeInfo = cached;
      }
    }

    // 4. Recompute if cache miss or invalidated
    if (!routeInfo) {
      // Try OSRM first if configured; fallback to straight-line on timeout/error
      const osrmResult = await this.fetchOsrmRoute(userLat, userLng, destLat, destLng);
      routeInfo = osrmResult || this.calculateStraightLineRoute(userLat, userLng, destLat, destLng);

      // Store in server-side cache
      this.cache.set(cacheKey, {
        ...routeInfo,
        computedAt: now,
        lat: userLat,
        lng: userLng
      });
    }

    const etaSeconds = isArrived ? 0 : routeInfo.etaSeconds;
    const etaTimestamp = now + (etaSeconds * 1000);

    // 5. Compute Lateness (ETA > start_time + grace)
    const effectiveDeadline = meetup.start_time + LATENESS_GRACE_PERIOD_MS;
    const isLate = !isArrived && (etaTimestamp > effectiveDeadline || (rsvp.lateness_minutes > 0));
    const lateByMinutes = isLate
      ? Math.max(rsvp.lateness_minutes || 0, Math.round((etaTimestamp - meetup.start_time) / 60000))
      : 0;

    return {
      meetupId,
      userId,
      userName: rsvp.user_name || 'Participant',
      rsvp: rsvp.rsvp,
      distanceMeters: Math.round(routeInfo.distanceMeters),
      etaSeconds,
      etaTimestamp,
      isApproximate: routeInfo.isApproximate,
      isLate,
      lateByMinutes,
      isArrived: Boolean(isArrived || rsvp.arrived_at),
      arrivedAt: rsvp.arrived_at,
      polyline: routeInfo.polyline
    };
  }

  /**
   * Clear cache for a specific user or meetup
   */
  clearUserCache(meetupId, userId) {
    this.cache.delete(`${meetupId}:${userId}`);
  }

  clearMeetupCache(meetupId) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${meetupId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Sweep and auto-end meetups 2 hours after their start time
   */
  sweepExpiredMeetups() {
    try {
      const endedMeetups = repo.autoEndExpiredMeetups(Date.now());
      for (const meetup of endedMeetups) {
        this.clearMeetupCache(meetup.id);
        if (this.io) {
          this.io.to(meetup.group_id).emit('meetup:ended', {
            meetupId: meetup.id,
            title: meetup.title,
            reason: 'auto_ended_2h'
          });
        }
      }
    } catch (err) {
      console.error('[RoutingService] Error in sweepExpiredMeetups:', err);
    }
  }
}

const routingService = new RoutingService();

module.exports = {
  routingService,
  RoutingService,
  DEFAULT_FALLBACK_SPEED_MPS,
  CACHE_TTL_MS,
  MOVEMENT_THRESHOLD_METERS,
  ARRIVAL_THRESHOLD_METERS,
  LATENESS_GRACE_PERIOD_MS
};
