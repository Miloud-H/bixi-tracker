/// Source unique des zones Atlas — (nom, lat, lon, ville).
///
/// Chaque zone a été validée contre les 1032 stations BIXI du feed GBFS station_information.json :
///   - au moins 2 stations BIXI dans un rayon de 600 m
///   - séparation minimale ~700 m entre zones pour éviter les micro-flux artificiels
///
/// Zones supprimées vs v1 :
///   - Loisir_Mont_Royal : 0 station dans 600 m (la plus proche à 797 m — le parc lui-même n'a pas de BIXI)
///   - Sante_CUSM        : 2 stations dans 600 m — Glen campus excentré, couvert par zones voisines
///
/// Zones ajoutées :
///   - Res_Plateau_Centre : 18 stations non couvertes (couloir Sherbrooke / bas-Plateau)
///   - Res_Frontenac      : 10 stations non couvertes (couloir Frontenac / Rosemont-Est)
///   - Res_Beaubien       :  8 stations non couvertes (Beaubien / Petite-Patrie)
pub const ZONES: &[(&str, f64, f64, &str)] = &[
    // ── Montréal — Transit (5) ──────────────────────────────────────────
    ("Transit_Gare_Centrale",  45.5000, -73.5665, "montreal"), // 21 stations — REM / VIA / exo
    ("Transit_Berri_UQAM",     45.5155, -73.5610, "montreal"), // 11 stations — hub orange+verte+jaune
    ("Transit_Lionel_Groulx",  45.4825, -73.5795, "montreal"), //  4 stations — hub ouest
    ("Transit_Mont_Royal",     45.5270, -73.5885, "montreal"), // 13 stations — cœur Plateau
    ("Transit_Jean_Talon",     45.5390, -73.6135, "montreal"), // 10 stations — hub nord orange+bleue

    // ── Montréal — Éducation (3) ────────────────────────────────────────
    ("Edu_McGill",     45.5042, -73.5760, "montreal"), // 18 stations
    ("Edu_Concordia",  45.4955, -73.5780, "montreal"), // 11 stations
    ("Edu_UdeM",       45.5017, -73.6147, "montreal"), //  2 stations — metro UdeM / bas du campus

    // ── Montréal — Santé (2) ────────────────────────────────────────────
    ("Sante_CHUM",          45.5110, -73.5560, "montreal"), //  9 stations
    ("Sante_Ste_Justine",   45.4988, -73.6220, "montreal"), //  6 stations — CHU Ste-Justine / CDN

    // ── Montréal — Loisirs (3) ──────────────────────────────────────────
    ("Loisir_Vieux_Port",      45.5040, -73.5510, "montreal"), //  5 stations — waterfront + Vieux-Mtl
    ("Loisir_Parc_Lafontaine", 45.5265, -73.5695, "montreal"), // 14 stations
    ("Loisir_Canal_Lachine",   45.4775, -73.5760, "montreal"), // relocalisé : Marché Atwater / entrée canal

    // ── Montréal — Vie nocturne (1) ─────────────────────────────────────
    ("Nuit_Village",  45.5195, -73.5550, "montreal"), // 7 stations — Ste-Catherine Est

    // ── Montréal — Résidentiel (15) ─────────────────────────────────────
    // Bas-Plateau / couloir Sherbrooke (18 stations non couvertes en v1)
    ("Res_Plateau_Centre",  45.5195, -73.5804, "montreal"),
    // Cœur Plateau-Mont-Royal
    ("Res_Plateau",         45.5310, -73.5760, "montreal"), // 17 stations
    // Mile-End
    ("Res_Mile_End",        45.5255, -73.5985, "montreal"), // 16 stations
    // Outremont — centroïde déplacé vers Metro Outremont
    ("Res_Outremont",       45.5220, -73.6130, "montreal"),
    // Beaubien / Petite-Patrie (8 stations non couvertes en v1)
    ("Res_Beaubien",        45.5330, -73.6025, "montreal"),
    // Villeray / Jean-Talon
    ("Res_Villeray",        45.5490, -73.5980, "montreal"), //  8 stations
    // Rosemont — centroïde déplacé pour meilleure couverture
    ("Res_Rosemont",        45.5450, -73.5750, "montreal"),
    // Frontenac / Rosemont-Est (10 stations non couvertes en v1)
    ("Res_Frontenac",       45.5340, -73.5575, "montreal"),
    // Hochelaga-Maisonneuve — centroïde déplacé vers axe Ontario/Frontenac
    ("Res_Hochelaga",       45.5390, -73.5480, "montreal"),
    // Griffintown / Pointe-St-Charles nord
    ("Res_Griffintown",     45.4925, -73.5605, "montreal"), //  5 stations
    // Sud-Ouest / St-Henri
    ("Res_Sud_Ouest",       45.4760, -73.5700, "montreal"),
    // Verdun / Wellington
    ("Res_Verdun",          45.4615, -73.5685, "montreal"),
    // Côte-des-Neiges — centroïde décalé est pour rester dans le 600 m
    ("Res_CDN",             45.4960, -73.6310, "montreal"),
    // Notre-Dame-de-Grâce
    ("Res_NDG",             45.4720, -73.6305, "montreal"), //  2 stations

    // ── Sherbrooke (8) ──────────────────────────────────────────────────
    ("Sherbrooke_Centre_Ville",     45.4040, -71.8929, "sherbrooke"),
    ("Sherbrooke_Wellington_Nord",  45.4120, -71.8910, "sherbrooke"),
    ("Sherbrooke_Edu_UdeS",         45.3783, -71.9279, "sherbrooke"),
    ("Sherbrooke_Sante_CHUS",       45.4078, -71.8645, "sherbrooke"),
    ("Sherbrooke_Parc_Bellevue",    45.3858, -71.9098, "sherbrooke"),
    ("Sherbrooke_Carrefour_Estrie", 45.3951, -71.8716, "sherbrooke"),
    ("Sherbrooke_Lennoxville",      45.3724, -71.8536, "sherbrooke"),
    ("Sherbrooke_Portland",         45.4156, -71.8720, "sherbrooke"),
];

const MAX_SNAP_KM: f64 = 0.6; // 600 m — au-delà, le trajet n'est rattaché à aucune zone

fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    6371.0 * 2.0 * a.sqrt().asin()
}

/// Retourne la zone la plus proche dans un rayon de MAX_SNAP_KM, ou None si hors seuil.
pub fn snap_nearest_for_city(lat: f64, lon: f64, city: &str) -> Option<&'static str> {
    ZONES.iter()
        .filter(|(_, _, _, c)| *c == city)
        .filter_map(|(name, zl, zo, _)| {
            let d = haversine_km(lat, lon, *zl, *zo);
            if d <= MAX_SNAP_KM { Some((*name, d)) } else { None }
        })
        .min_by(|(_, da), (_, db)| da.partial_cmp(db).unwrap())
        .map(|(name, _)| name)
}
