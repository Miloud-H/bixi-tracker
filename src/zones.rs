/// Source unique des zones Atlas — (nom, lat, lon, ville).
///
/// Principes de sélection :
///   - Attracteurs réels : hubs de transit, universités, hôpitaux, parcs majeurs, quartiers
///   - Séparation minimale ~700 m entre zones du même type pour éviter les micro-flux artificiels
///   - Seuil de snap 600 m : tout trajet dont ni l'origine ni la destination n'est
///     dans ce rayon est écarté plutôt que rattaché au plus proche par défaut
pub const ZONES: &[(&str, f64, f64, &str)] = &[
    // ── Montréal — Transit (5) ──────────────────────────────────────────
    // Grands nœuds de correspondance : génèrent les flux domicile↔travail les plus nets
    ("Transit_Gare_Centrale",  45.5000, -73.5665, "montreal"), // VIA / exo / REM Bonaventure
    ("Transit_Berri_UQAM",     45.5155, -73.5610, "montreal"), // orange + verte + jaune
    ("Transit_Lionel_Groulx",  45.4825, -73.5795, "montreal"), // orange + verte, hub ouest
    ("Transit_Mont_Royal",     45.5270, -73.5885, "montreal"), // orange, cœur du Plateau
    ("Transit_Jean_Talon",     45.5390, -73.6135, "montreal"), // orange + bleue, hub nord

    // ── Montréal — Éducation (4) ────────────────────────────────────────
    // Générateurs massifs matin/soir en semaine
    ("Edu_McGill",      45.5042, -73.5760, "montreal"),
    ("Edu_Concordia",   45.4955, -73.5780, "montreal"),
    ("Edu_UdeM",        45.5044, -73.6130, "montreal"), // inclut Polytechnique et HEC
    ("Edu_ETS",         45.4945, -73.5625, "montreal"),

    // ── Montréal — Santé (3) ────────────────────────────────────────────
    ("Sante_CHUM",         45.5110, -73.5560, "montreal"),
    ("Sante_CUSM",         45.4725, -73.5995, "montreal"), // site Glen
    ("Sante_Ste_Justine",  45.5030, -73.6235, "montreal"),

    // ── Montréal — Loisirs / parcs (4) ─────────────────────────────────
    ("Loisir_Vieux_Port",       45.5040, -73.5510, "montreal"), // waterfront + Vieux-Montréal
    ("Loisir_Parc_Lafontaine",  45.5265, -73.5695, "montreal"),
    ("Loisir_Mont_Royal",       45.5005, -73.5905, "montreal"), // accès parc + belvédère
    ("Loisir_Canal_Lachine",    45.4680, -73.5850, "montreal"), // piste cyclable, Atwater→LaSalle

    // ── Montréal — Vie nocturne (1) ─────────────────────────────────────
    ("Nuit_Village",  45.5195, -73.5550, "montreal"), // Ste-Catherine Est

    // ── Montréal — Résidentiel (11) ─────────────────────────────────────
    // Zones assez grandes pour capturer les départs/arrivées de quartier sans créer
    // de micro-flux entre zones voisines
    ("Res_Plateau",     45.5310, -73.5760, "montreal"), // cœur Plateau-Mont-Royal
    ("Res_Mile_End",    45.5255, -73.5985, "montreal"), // Mile-End / Laurier Ouest
    ("Res_Outremont",   45.5155, -73.6120, "montreal"), // Outremont / Van Horne
    ("Res_Villeray",    45.5490, -73.5980, "montreal"), // Villeray / marché Jean-Talon
    ("Res_Rosemont",    45.5440, -73.5650, "montreal"), // Rosemont–La Petite-Patrie
    ("Res_Hochelaga",   45.5445, -73.5415, "montreal"), // Hochelaga-Maisonneuve
    ("Res_Griffintown", 45.4925, -73.5605, "montreal"), // Griffintown / Pointe-St-Charles nord
    ("Res_Sud_Ouest",   45.4760, -73.5700, "montreal"), // St-Henri / Pointe-St-Charles
    ("Res_Verdun",      45.4615, -73.5685, "montreal"), // Verdun / Wellington
    ("Res_CDN",         45.4945, -73.6380, "montreal"), // Côte-des-Neiges
    ("Res_NDG",         45.4720, -73.6305, "montreal"), // Notre-Dame-de-Grâce

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
