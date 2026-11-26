// Espace disque de la base de données (disque permanent en production) : affiché dans /health, alerte de saturation.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** Occupation du système de fichiers qui contient la base. null si indisponible. */
export function diskUsage(file = config.dbPath) {
  try {
    const s = fs.statfsSync(path.dirname(path.resolve(file)));
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    const dbBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    return { totalMo: Math.round(total / 1048576), libreMo: Math.round(free / 1048576), utilisePct: total ? Math.round((1 - free / total) * 100) : 0, baseMo: Math.round(dbBytes / 1048576 * 10) / 10, alerte: total ? (1 - free / total) * 100 >= config.diskAlertPct : false };
  } catch { return null; }
}
