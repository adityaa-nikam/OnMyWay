# OnMyWay (OMW) Design System

## 1. Overview & Philosophy

The OnMyWay design system is a minimalist, white-monochrome interface ported from the **shadcn/ui "neutral" theme**. It delivers a calm, quiet, and premium feel in the spirit of Vercel and Linear, emphasizing generous whitespace, thin 1px borders, subtle shadows, and zero colored gradients.

- **Stack**: Express + EJS + Vanilla JS + Leaflet (Strictly zero React, zero frontend bundlers).
- **Core Principle**: *Meaning without color*. Because the palette is monochrome, state is conveyed via iconography, typography, weight, and shape (e.g. filled vs. outlined).
- **The Only Colored Accent**: `--destructive` (a muted red) is reserved strictly for Emergency SOS beacons and irreversible destructive confirmations (such as account deletion).

---

## 2. Design Tokens (CSS Variables)

All design tokens are defined in HSL format matching shadcn neutral theme specifications, facilitating future React migrations without variable churn:

```css
:root {
  /* Surfaces & Text */
  --background: 0 0% 100%;          /* #ffffff */
  --foreground: 0 0% 3.9%;          /* #09090b - Near-black */
  --card: 0 0% 100%;
  --card-foreground: 0 0% 3.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 3.9%;

  /* Neutral Interactive Grays */
  --primary: 0 0% 9%;               /* #18181b */
  --primary-foreground: 0 0% 98%;   /* #fafafa */
  --secondary: 0 0% 96.1%;          /* #f4f4f5 */
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96.1%;
  --muted-foreground: 0 0% 45.1%;   /* #71717a */
  --accent: 0 0% 96.1%;
  --accent-foreground: 0 0% 9%;

  /* Form & Boundary Controls */
  --border: 0 0% 89.8%;             /* #e4e4e7 - Thin 1px boundary */
  --input: 0 0% 89.8%;
  --ring: 0 0% 3.9%;                /* Focus ring */
  --radius: 0.5rem;                 /* 8px base border radius */

  /* The Single Allowed Color (Emergency / Destructive Only) */
  --destructive: 0 84.2% 60.2%;     /* Muted red */
  --destructive-foreground: 0 0% 98%;
}
```

---

## 3. Typography & Icons

- **Typography**: Self-hosted sans-serif stack (`Geist` / `Inter` / system-ui fallback).
  - Sizes: `12px` (micro), `14px` (app base), `16px` (body), `20px` (subheading), `24px` (title), `32px`+ (display).
  - Headings feature tight letter tracking (`tracking-tight` / `-0.015em`).
- **Icons**: Lucide icons compiled into an SVG sprite at `/icons/sprite.svg` (30+ symbols, 1.5 stroke width, strictly monochrome). Rendered via `<use href="/icons/sprite.svg#icon-name"/>`.

---

## 4. Component Anatomy (`views/components/`)

The component library contains 23 reusable EJS partials ported from shadcn anatomy:

| Component | Path | Description & Variants |
|---|---|---|
| **Button** | `components/button.ejs` | Variants: `default`, `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes: `sm`, `default`, `lg`, `icon`. |
| **Input** | `components/input.ejs` | Types: `text`, `email`, `password`, `number`, `search`. Features subtle focus ring. |
| **Textarea** | `components/textarea.ejs` | Multi-line text entry with ring focus state. |
| **Label** | `components/label.ejs` | Accessible form label with optional required indicator. |
| **Select** | `components/select.ejs` | Custom dropdown selector with chevron icon. |
| **Switch** | `components/switch.ejs` | Accessible toggle switch with `role="switch"`. |
| **Checkbox** | `components/checkbox.ejs` | Monochrome checkbox with checkmark SVG indicator. |
| **Badge** | `components/badge.ejs` | Variants: `default` (black), `secondary` (muted), `outline` (bordered), `destructive` (red). |
| **Avatar** | `components/avatar.ejs` | Monochrome initials avatar with status dots: `live` (pulse), `paused` (hollow), `offline`. |
| **Card** | `components/card.ejs` | Elevated card container with header, title, description, content, and footer slots. |
| **Separator** | `components/separator.ejs` | 1px neutral divider in horizontal or vertical orientation. |
| **Skeleton** | `components/skeleton.ejs` | Pulsing shimmer placeholder blocks and circles for loading states. |
| **Alert** | `components/alert.ejs` | Callout notification cards: `default` (monochrome) and `destructive` (critical). |
| **Tabs** | `components/tabs.ejs` | Segmented control and tab panels. |
| **Toast** | `components/toast.ejs` | Sonner-style fixed toast viewport with `window.toast(...)`. |
| **Tooltip** | `components/tooltip.ejs` | Lightweight popover tooltip with data-tooltip trigger. |
| **Progress** | `components/progress.ejs` | Linear progress bar & radial SVG ring for 3-second hold actions. |
| **Dialog** | `components/dialog.ejs` | Accessible modal dialog with backdrop blur, focus trap, and ESC dismissal. |
| **Sheet** | `components/sheet.ejs` | Slide-over drawer (right sheet on desktop, bottom sheet on mobile). |
| **Dropdown** | `components/dropdown.ejs` | Popover action menu with menu items and separators. |
| **Scroll Area** | `components/scroll-area.ejs` | Overflow wrapper with slim custom scrollbars. |
| **Empty State** | `components/empty-state.ejs` | Icon, headline, supporting text, and primary call-to-action button. |
| **Icon** | `components/icon.ejs` | SVG sprite consumer `<use href="/icons/sprite.svg#..."/>`. |

---

## 5. Usage Rules & Guidelines

### Content Security Policy (CSP) & Security
1. **Never use `innerHTML` with untrusted data**: Always render user-submitted content (messages, display names, room labels) using `textContent` or text node interpolation.
2. **No Inline Scripts or Inline Event Handlers**: Do not write `onclick="..."` on components. Bind event listeners using `data-*` attributes and vanilla JS delegation in `public/js/ui/*.js`.
3. **Zero CDNs**: All fonts, icons, and styles are self-hosted within the `/public` directory.

### Leaflet Map Theming
1. **Tiles**: High-Precision Vector Roadmap (`https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}`), Satellite Hybrid (`lyrs=y`), Clean Monochrome (`.leaflet-desaturated-tiles`), and OpenStreetMap. Carto is deprecated due to API key watermarks. Keep provider attributions visible.
2. **Markers**:
   - **Live Sharing**: Solid black dot with a white ring and soft outward pulse.
   - **Hover / Selected**: Shows initials avatar pill.
   - **Paused / Stale**: Hollow grey ring (`border: 2px solid #71717a`).
3. **Routes**: 2px dark-grey lines (`#3f3f46`).
4. **Geofences / Place Circles**: Light-grey fill (`#e4e4e7`, opacity 0.25) with dashed 1px border (`#71717a`).
5. **Zoom Controls & Popups**: Styled to match shadcn cards (white background, 1px border, 0.5rem radius, subtle shadow).

### Chat UI
1. **No colored bubbles**:
   - Own messages: Right-aligned on muted gray (`bg-muted`, border `border-border`).
   - Others' messages: Left-aligned on white (`bg-card`, border `border-border`).
2. **Status Chips**: Outlined pill badges (`border border-input text-foreground bg-background hover:bg-accent`).
3. **Emergency SOS**: Displayed in prominent callout banner with 60-second cooldown rate limiting.

---

## 6. Do's and Don'ts

### DO
- **DO** maintain generous whitespace and padding around cards, inputs, and typography.
- **DO** use the single `--destructive` token exclusively for Emergency SOS beacons and irreversible deletion.
- **DO** provide empty states and loading skeletons for every dynamic list.
- **DO** support `prefers-reduced-motion` by disabling transitions and animations.
- **DO** respect safe-area insets (`env(safe-area-inset-*)`) for mobile Capacitor shell compatibility.

### DON'T
- **DON'T** introduce arbitrary brand colors, saturated greens, or blues.
- **DON'T** use heavy drop shadows or colored gradients.
- **DON'T** add React, Vue, or client-side bundlers.
- **DON'T** use colored chat bubbles (e.g. green WhatsApp or blue iMessage bubbles).
- **DON'T** rely on color alone to indicate status—always pair with text, weight, or icon.

---

## 7. Developer Scripts & Dependencies

### New Dev Dependencies
- `tailwindcss` (^3.4.19): Compiles utility classes into `public/css/app.css`.
- `axe-core` (^4.14.0): Automated accessibility compliance engine.
- `puppeteer-core` (^25.16.0): Headless verification and smoke testing.

### NPM Scripts
```bash
# Build minified CSS bundle (~37 KB uncompressed, ~9 KB gzipped)
npm run build:css

# Watch for CSS changes during local development
npm run watch:css

# Run smoke test suite across 3 viewports (375px, 768px, 1280px) + axe scans
npm run test:smoke

# Run the complete test suite (130 automated security & functionality checks)
npm test
```

---

## 8. Manual QA Verification Steps

1. **Responsive Viewport Testing**:
   - Mobile: 375 × 812 px (Verify bottom tab bar `Chat / Map / People` and zero horizontal scroll).
   - Tablet: 768 × 1024 px.
   - Desktop: 1280 × 800 px (Verify three-pane layout: `people | chat | map`).
2. **Keyboard & Focus Navigation**:
   - Tab through all form inputs, modals, and buttons.
   - Verify visible focus rings (`focus-visible:ring-1 focus-visible:ring-ring`).
   - Open dialogs/modals and verify `Escape` key closes them and focus traps work.
3. **Emergency SOS Action**:
   - Press and hold the SOS button for 3 seconds.
   - Observe the radial progress ring filling with `--destructive`.
   - Release before 3 seconds to verify cancellation; hold full duration to trigger broadcast.
4. **Time-Boxed Sharing**:
   - Start 15-minute share.
   - Confirm persistent header pill displays: `"Sharing with N people until HH:MM"` with working `+15m Extend` and `Stop` buttons.
5. **Offline Page**:
   - Disconnect network or open `http://localhost:3000/offline.html`.
   - Verify calm monochrome offline card with "Retry Connection" button.
