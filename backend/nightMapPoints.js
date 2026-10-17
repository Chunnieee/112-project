// Limit map payloads without changing the full counts used for scoring.
export function mapPointCollection(points, kind, limit = 2000) {
  const valid = points.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  const shown = Math.min(limit, valid.length);
  const features = Array.from({ length: shown }, (_, i) => {
    const p = valid[Math.floor(i * valid.length / shown)];
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
      properties: { kind, name: kind === 'streetlights' ? '路燈登記點位' : kind === 'accidents' ? '歷史事故' : String(p.name || p.store_type || '便利商店').slice(0,120),
        date: kind === 'accidents' ? String(p.date || '').slice(0,10) : undefined, severity: kind === 'accidents' ? String(p.severity || '').slice(0,40) : undefined,
        fatal: kind === 'accidents' ? (p.category === 'A1' || /死亡\s*[1-9]/.test(String(p.severity || ''))) : undefined,
        location: kind === 'accidents' ? String(p.location || '').slice(0,120) : undefined,
        involved: kind === 'accidents' && p.involved ? String(p.involved).slice(0,40) : undefined,
        brand: String(p.store_type || '').slice(0,60), address: String(p.address || '').slice(0,200),
        distanceMeters: Number.isFinite(p.distanceMeters) ? Math.round(p.distanceMeters) : null } };
  });
  return { type: 'FeatureCollection', features, total: valid.length, shown, truncated: shown < valid.length };
}
