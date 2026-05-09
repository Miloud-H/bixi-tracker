/// Source unique des zones Atlas — (nom, lat, lon, ville).
pub const ZONES: &[(&str, f64, f64, &str)] = &[
    // ── Montréal ───────────────────────────────────────────────────────
    ("Transit_Gare_Centrale",       45.5000, -73.5665, "montreal"),
    ("Transit_Gare_Lucien_Lallier", 45.4950, -73.5710, "montreal"),
    ("Transit_Gare_Parc",           45.5315, -73.6235, "montreal"),
    ("Transit_Berri_UQAM",          45.5155, -73.5610, "montreal"),
    ("Transit_Vendome",             45.4740, -73.6035, "montreal"),
    ("Transit_Snowdon",             45.4855, -73.6275, "montreal"),
    ("Transit_Jean_Talon_Metro",    45.5390, -73.6135, "montreal"),
    ("Transit_Lionel_Groulx",       45.4825, -73.5795, "montreal"),
    ("Edu_UdeM_Poly",               45.5044, -73.6130, "montreal"),
    ("Edu_McGill",                  45.5042, -73.5760, "montreal"),
    ("Edu_Concordia_Guy",           45.4955, -73.5780, "montreal"),
    ("Edu_UQAM_Design",             45.5135, -73.5685, "montreal"),
    ("Edu_HEC_Mtl",                 45.5035, -73.6205, "montreal"),
    ("Edu_ETS",                     45.4945, -73.5625, "montreal"),
    ("Sante_CHUM",                  45.5110, -73.5560, "montreal"),
    ("Sante_CUSM_Glen",             45.4725, -73.5995, "montreal"),
    ("Sante_H_Sainte_Justine",      45.5030, -73.6235, "montreal"),
    ("Sante_H_General_Mtl",         45.4975, -73.5885, "montreal"),
    ("Sante_H_Notre_Dame",          45.5265, -73.5575, "montreal"),
    ("Res_Angus",                   45.5410, -73.5650, "montreal"),
    ("Res_Plateau_Est",             45.5320, -73.5725, "montreal"),
    ("Res_Mile_End",                45.5255, -73.5985, "montreal"),
    ("Res_Hochelaga",               45.5435, -73.5415, "montreal"),
    ("Res_Verdun_Wellington",       45.4615, -73.5685, "montreal"),
    ("Res_Sud_Ouest",               45.4855, -73.5820, "montreal"),
    ("Res_Griffintown",             45.4925, -73.5605, "montreal"),
    ("Res_Little_Italy",            45.5345, -73.6125, "montreal"),
    ("Res_Outremont",               45.5155, -73.6055, "montreal"),
    ("Affaires_Ville_Marie",        45.5019, -73.5677, "montreal"),
    ("Comm_Marche_Jean_Talon",      45.5361, -73.6150, "montreal"),
    ("Comm_Marche_Atwater",         45.4795, -73.5765, "montreal"),
    ("Comm_Mont_Royal_Avenue",      45.5245, -73.5815, "montreal"),
    ("Comm_Ste_Catherine_Ouest",    45.5015, -73.5725, "montreal"),
    ("Comm_Chabanel",               45.5410, -73.6550, "montreal"),
    ("Loisir_Vieux_Port",           45.5040, -73.5510, "montreal"),
    ("Loisir_Parc_Lafontaine",      45.5265, -73.5695, "montreal"),
    ("Loisir_Canal_Lachine",        45.4800, -73.5780, "montreal"),
    ("Loisir_Parc_Mont_Royal",      45.4975, -73.5905, "montreal"),
    ("Nuit_Crescent",               45.4985, -73.5765, "montreal"),
    ("Nuit_Village",                45.5195, -73.5550, "montreal"),
    ("Res_Rosemont",                45.5445, -73.5810, "montreal"),
    ("Res_Petite_Patrie",           45.5360, -73.5940, "montreal"),
    ("Res_Villeray",                45.5490, -73.6190, "montreal"),
    ("Res_Cote_des_Neiges",         45.4945, -73.6380, "montreal"),
    ("Res_NDG",                     45.4720, -73.6380, "montreal"),
    ("Res_Pointe_St_Charles",       45.4650, -73.5555, "montreal"),
    ("Res_Centre_Sud",              45.5175, -73.5465, "montreal"),
    ("Res_Maisonneuve",             45.5490, -73.5320, "montreal"),
    ("Res_Parc_Extension",          45.5295, -73.6380, "montreal"),
    ("Res_Westmount",               45.4815, -73.6010, "montreal"),
    ("Res_Plateau_Ouest",           45.5245, -73.5875, "montreal"),
    ("Res_Rosemont_Est",            45.5480, -73.5530, "montreal"),
    ("Transit_Papineau",            45.5260, -73.5500, "montreal"),
    ("Transit_Plamondon",           45.4860, -73.6400, "montreal"),
    ("Transit_Joliette",            45.5395, -73.5285, "montreal"),
    ("Transit_Charlevoix",          45.4680, -73.5660, "montreal"),
    ("Loisir_Parc_Maisonneuve",     45.5545, -73.5475, "montreal"),

    // ── Sherbrooke ─────────────────────────────────────────────────────
    ("Sherbrooke_Centre_Ville",     45.4040, -71.8929, "sherbrooke"),
    ("Sherbrooke_Wellington_Nord",  45.4120, -71.8910, "sherbrooke"),
    ("Sherbrooke_Edu_UdeS",         45.3783, -71.9279, "sherbrooke"),
    ("Sherbrooke_Sante_CHUS",       45.4078, -71.8645, "sherbrooke"),
    ("Sherbrooke_Parc_Bellevue",    45.3858, -71.9098, "sherbrooke"),
    ("Sherbrooke_Carrefour_Estrie", 45.3951, -71.8716, "sherbrooke"),
    ("Sherbrooke_Lennoxville",      45.3724, -71.8536, "sherbrooke"),
    ("Sherbrooke_Portland",         45.4156, -71.8720, "sherbrooke"),
];

pub fn snap_nearest_for_city(lat: f64, lon: f64, city: &str) -> Option<&'static str> {
    ZONES.iter()
        .filter(|(_, _, _, c)| *c == city)
        .min_by(|(_, al, ao, _), (_, bl, bo, _)| {
            let da = (lat - al).powi(2) + (lon - ao).powi(2);
            let db = (lat - bl).powi(2) + (lon - bo).powi(2);
            da.partial_cmp(&db).unwrap()
        })
        .map(|(name, _, _, _)| *name)
}
