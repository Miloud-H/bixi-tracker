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
///   - 2026-09-12 : Chambly, Sainte-Julie, Saint-Eustache, Sainte-Thérèse — BIXI a étendu
///     le service à ces banlieues (confirmé via le flux GBFS live, chacune à 18-22 km de
///     la zone Montréal la plus proche donc hors du rayon de snap de 900 m). Restent dans
///     le bucket ville "montreal" (même filtre `lon < -72.5`) — ce ne sont pas une 3e ville,
///     juste de nouvelles zones dans le bucket existant.
///   - 2026-09-12 (suite) : Deux-Montagnes / Sainte-Marthe-sur-le-Lac (corridor étalé
///     autour de Saint-Eustache) et 4 zones Longueuil (déploiement Rive-Sud complet,
///     pas une simple banlieue satellite).
///
/// TODO — refresh système complet à faire (pas urgent, gros chantier) : en ré-appliquant
/// les mêmes critères de validation ci-dessus sur le flux GBFS live du 2026-09-12
/// (1081 stations dans le bucket "montreal", vs 1032 à la création des zones), 553
/// stations (~51%) sont à plus de 900 m de toute zone existante, formant 96 clusters
/// d'au moins 2 stations à moins de 600 m — y compris en plein Montréal central
/// (ex. Villeray/Jarry : 13 stations, Hochelaga : 10, Rosemont : 8). Le réseau a
/// visiblement beaucoup grandi depuis la dernière validation. Script de clustering :
/// analysis/suburb_clustering.py (gitignoré). Mérite sa propre passe complète avec
/// curation manuelle des noms/centroïdes, pas un ajout à la volée.
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

    // ── Montréal — Banlieues éloignées (10) ─────────────────────────────
    // Toujours ville "montreal" (lon < -72.5) — ce sont des zones dans le
    // bucket existant, pas une nouvelle ville. Isolées géographiquement
    // (18-22 km de la zone montréalaise la plus proche), donc sans elles
    // ces trajets ne matchaient aucune zone à moins de 900 m.
    ("Chambly",         45.4474, -73.2783, "montreal"), //  4 stations — Bourgogne / Langevin
    ("Sainte_Julie",    45.5823, -73.3243, "montreal"), //  5 stations — Terminus Ste-Julie
    ("Sainte_Therese",  45.6391, -73.8262, "montreal"), //  6 stations — Place Gabriel-Labelle

    // Rive-Nord (Deux-Montagnes) : corridor étalé sur ~6 km, pas un seul
    // hub compact — une zone ne suffisait pas (2026-09-12, seulement 3
    // stations sur 23 dans 6 km étaient à moins de 900 m de l'unique zone).
    ("Saint_Eustache",           45.5576, -73.8890, "montreal"), //  3 stations dans 900m — Mairie de St-Eustache
    ("Deux_Montagnes",           45.5405, -73.9000, "montreal"), //  2 stations dans 900m — gare REM
    ("Sainte_Marthe_sur_le_Lac", 45.5373, -73.9261, "montreal"), //  2 stations dans 900m — des Promenades

    // Longueuil : déploiement complet (Rive-Sud), pas une petite banlieue
    // satellite comme Chambly — plusieurs pôles distincts identifiés.
    ("Longueuil_Centre",          45.5242, -73.5198, "montreal"), // 4 stations — Métro Longueuil–Université-de-Sherbrooke
    ("Longueuil_Roland_Therrien", 45.5370, -73.4790, "montreal"), // 5 stations — Hôpital Pierre-Boucher / Cégep Édouard-Montpetit
    ("Longueuil_Coteau_Rouge",    45.5220, -73.4950, "montreal"), // 6 stations — secteur résidentiel Coteau-Rouge
    ("Longueuil_St_Hubert",       45.5107, -73.4316, "montreal"), // 2 stations — Gare Longueuil–St-Hubert

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

// 900 m — au-delà, le trajet n'est rattaché à aucune zone.
// Relevé le 2026-08-28 après analyse de 1,54M trajets : à 600 m, ~47% du trafic
// tombait hors de toute zone, concentré dans les interstices entre zones voisines
// (espacées d'~700 m par design) plutôt que dispersé au hasard. 900 m récupère ~47%
// de ce volume non couvert (couverture globale ~53% → ~75%) sans avoir besoin de
// nouvelles zones. Le reliquat (~27% du non-couvert, trajets à 1,5 km+ de toute
// zone) est un vrai trou géographique — candidat pour de nouvelles zones, pas pour
// un rayon encore plus généreux.
const MAX_SNAP_KM: f64 = 0.9;

pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haversine_same_point_is_zero() {
        assert_eq!(haversine_km(45.5, -73.5, 45.5, -73.5), 0.0);
    }

    #[test]
    fn haversine_known_distance() {
        // McGill (Edu_McGill) to Berri-UQAM (Transit_Berri_UQAM), roughly ~1.6 km apart.
        let d = haversine_km(45.5042, -73.5760, 45.5155, -73.5610);
        assert!(d > 1.3 && d < 1.9, "expected ~1.3-1.9 km, got {d}");
    }

    #[test]
    fn snap_matches_exact_zone_coordinate() {
        // Querying a zone's own centroid must snap to that zone.
        let (name, lat, lon, city) = ZONES[0];
        assert_eq!(snap_nearest_for_city(lat, lon, city), Some(name));
    }

    #[test]
    fn snap_returns_none_beyond_radius() {
        // The middle of the St. Lawrence, nowhere near any named zone.
        assert_eq!(snap_nearest_for_city(45.50, -73.52, "montreal"), None);
    }

    #[test]
    fn snap_respects_city_filter() {
        // A Sherbrooke zone's own coordinates must not match under "montreal".
        let (_, lat, lon, _) = ZONES.iter().find(|(_, _, _, c)| *c == "sherbrooke").unwrap();
        assert_eq!(snap_nearest_for_city(*lat, *lon, "montreal"), None);
    }
}
