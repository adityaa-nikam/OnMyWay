const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function runMigrations(db) {
  // Ensure foreign keys are enabled
  db.pragma('foreign_keys = ON');

  // Track applied migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const getApplied = db.prepare('SELECT name FROM _migrations WHERE name = ?');
  const recordMigration = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    const applied = getApplied.get(file);
    if (!applied) {
      console.log(`Applying migration: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      const transaction = db.transaction(() => {
        db.exec(sql);
        recordMigration.run(file, Date.now());
      });
      transaction();
      console.log(`Applied migration: ${file}`);
    }
  }
}

module.exports = { runMigrations };
