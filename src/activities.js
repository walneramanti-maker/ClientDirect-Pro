// Catalogue des activités proposées à l'inscription : catégories, sous-catégories, prestations adaptées à chaque métier.
// Chaque activité s'appuie sur un « profil » (mode de fonctionnement du site : rendez-vous, devis, table, séjour, cours…)
// et sur un modèle de base historique (garage, coiffeur, beaute, restaurant, securite, location, artisan) pour la compatibilité.
// Aucun prix n'est fixé ici : les tarifs sont saisis et confirmés par le professionnel lui-même.
// a : [clé, libellé FR, libellé EN, modèle de base, profil, codes NAF, prestations [nom, durée min, description], options]
// options : o = précision demandée au client, v = verbe du bouton, kw = mots-clés de recherche, np = exclu de la prospection,
//           sch = type schema.org

export const CATEGORIES = {
  auto: { fr: 'Automobile et mobilité', en: 'Automotive and mobility' },
  beaute: { fr: 'Beauté et bien-être', en: 'Beauty and wellness' },
  sante: { fr: 'Santé et paramédical', en: 'Health and paramedical' },
  sport: { fr: 'Sport, coaching et loisirs', en: 'Sport, coaching and leisure' },
  food: { fr: 'Restauration et alimentation', en: 'Food and drink' },
  btp: { fr: 'Bâtiment et travaux', en: 'Building and trades' },
  maison: { fr: 'Services à domicile et entretien', en: 'Home services and cleaning' },
  commerce: { fr: 'Commerces et boutiques', en: 'Shops and retail' },
  event: { fr: 'Événementiel, photo et culture', en: 'Events, photo and culture' },
  tourisme: { fr: 'Tourisme et hébergement', en: 'Tourism and accommodation' },
  formation: { fr: 'Formation et enseignement', en: 'Training and teaching' },
  conseil: { fr: 'Conseil et services aux entreprises', en: 'Business services and consulting' },
  animaux: { fr: 'Animaux', en: 'Pets and animals' },
  transport: { fr: 'Transport et logistique', en: 'Transport and logistics' },
  nature: { fr: 'Jardin, nature et agriculture', en: 'Garden, nature and farming' }
};

// Profils : comportement du site et textes par défaut (horaires, postes, bouton, précision demandée, arguments)
const W = (wk, sat = null, sun = null) => ({ 1: wk, 2: wk, 3: wk, 4: wk, 5: wk, 6: sat, 0: sun });
export const PROFILES = {
  rdv: { verb: 'Prendre rendez-vous', verbEn: 'Book an appointment', obj: 'Précisions sur votre demande', staff: ['Agenda 1'], hours: W(['09:00', '18:00'], ['09:00', '13:00']), faq: "Merci de prévenir 24 h à l'avance en cas d'annulation.", plan: 'pro',
    need: 'Quand vous êtes occupé avec un client, vous ne pouvez pas répondre au téléphone : chaque appel manqué peut être un rendez-vous perdu.', does: ['réserver un créneau en ligne, 24 h/24', 'choisir la prestation qui leur convient', 'vous écrire directement sur WhatsApp'] },
  devis: { verb: 'Demander une intervention', verbEn: 'Request a visit', obj: 'Adresse et description des travaux', staff: ['Équipe 1'], hours: W(['07:30', '17:00'], ['08:00', '12:00']), faq: 'Devis gratuit. Paiement par virement, chèque ou carte.', plan: 'essentiel',
    need: 'Sur un chantier ou en intervention, vous ne pouvez pas toujours décrocher : un client qui ne vous joint pas appelle le suivant.', does: ['vous envoyer une demande de devis détaillée', 'prendre rendez-vous pour une visite', 'vous écrire directement sur WhatsApp'] },
  table: { verb: 'Réserver', verbEn: 'Book', obj: 'Nombre de personnes', staff: ['Table A', 'Table B', 'Table C'], hours: W(['11:30', '14:30'], ['11:30', '22:00']), faq: 'Plats à emporter possibles selon le service. Paiement par carte ou espèces.', plan: 'pro',
    need: 'Beaucoup de clients choisissent où sortir sur leur téléphone, souvent au dernier moment.', does: ['réserver en ligne en indiquant le nombre de personnes', 'vous demander un devis pour un événement', 'vous écrire directement sur WhatsApp'] },
  commande: { verb: 'Réserver ou commander', verbEn: 'Order or reserve', obj: 'Article ou produit souhaité', staff: ['Boutique'], hours: W(['09:00', '19:00'], ['09:00', '19:00']), faq: 'Retrait en boutique sur rendez-vous. Paiement par carte ou espèces.', plan: 'essentiel',
    need: 'Avant de se déplacer, la plupart des clients vérifient en ligne vos horaires, vos produits et s’ils peuvent réserver.', does: ['réserver un article ou un retrait en boutique', 'vous poser une question avant de venir', 'vous écrire directement sur WhatsApp'] },
  sejour: { verb: 'Demander une réservation', verbEn: 'Request a booking', obj: 'Dates souhaitées et nombre de personnes', staff: ['Accueil'], hours: W(['08:00', '20:00'], ['08:00', '20:00'], ['08:00', '20:00']), faq: 'Réservation confirmée après acompte. Annulation selon conditions.', plan: 'pro',
    need: 'Les voyageurs réservent depuis leur téléphone, souvent avant d’arriver, et comparent plusieurs offres.', does: ['vous envoyer une demande avec leurs dates', 'réserver une activité ou un créneau', 'vous écrire directement sur WhatsApp'] },
  cours: { verb: 'Réserver une séance', verbEn: 'Book a session', obj: 'Niveau et objectif', staff: ['Séance'], hours: W(['09:00', '20:00'], ['09:00', '13:00']), faq: "Première séance d'essai sur demande. Merci de prévenir 24 h à l'avance en cas d'annulation.", plan: 'pro',
    need: 'Vos élèves et clients veulent réserver une séance sans vous appeler, à toute heure.', does: ['réserver une séance en ligne', 'indiquer leur niveau et leur objectif', 'vous écrire directement sur WhatsApp'] },
  conseil: { verb: 'Prendre rendez-vous', verbEn: 'Book a meeting', obj: 'Objet du rendez-vous', staff: ['Conseiller'], hours: W(['09:00', '18:00']), faq: 'Premier échange sans engagement. Devis remis avant toute mission.', plan: 'essentiel',
    need: 'Un client qui vous cherche compare d’abord en ligne, puis contacte le professionnel le plus simple à joindre.', does: ['prendre rendez-vous pour un premier échange', 'vous envoyer une demande de devis', 'vous écrire directement sur WhatsApp'] }
};

const A = [
  ['#auto'],
  ['garage', 'Garage automobile', 'Auto repair shop', 'garage', 'rdv', ['45.20A', '45.20B'], null, { o: 'Véhicule (marque, modèle, année)', kw: 'mécanicien garagiste mécanique entretien vidange' }],
  ['carrosserie', 'Carrosserie', 'Body shop', 'garage', 'devis', ['45.20A'], [['Devis carrosserie', 30, 'Estimation des réparations sur photo ou sur place.'], ['Réparation de carrosserie', 240, 'Débosselage, remplacement d’éléments.'], ['Peinture', 480, 'Peinture d’un élément ou du véhicule.']], { o: 'Véhicule et dommages', kw: 'tôlerie peinture bosse' }],
  ['pneus', 'Pneumatiques', 'Tyre shop', 'garage', 'rdv', ['45.32Z'], [['Montage de pneus', 45, 'Montage, équilibrage.'], ['Géométrie', 45, 'Réglage du parallélisme.'], ['Réparation de crevaison', 30, 'Contrôle et réparation.']], { o: 'Dimensions des pneus', kw: 'pneu crevaison géométrie' }],
  ['lavage-auto', 'Lavage et nettoyage auto', 'Car wash and valeting', 'garage', 'rdv', ['45.20A'], [['Lavage extérieur', 30, 'Carrosserie, jantes, vitres.'], ['Nettoyage intérieur', 60, 'Aspiration, plastiques, vitres.'], ['Nettoyage complet', 120, 'Intérieur et extérieur.']], { o: 'Type de véhicule', kw: 'lavage detailing nettoyage' }],
  ['moto', 'Garage moto et scooter', 'Motorbike garage', 'garage', 'rdv', ['45.40Z'], [['Révision', 90, 'Vidange, contrôle des points de sécurité.'], ['Pneus et freins', 60, 'Remplacement et contrôle.'], ['Diagnostic', 45, 'Recherche de panne.']], { o: 'Modèle et année', kw: 'moto scooter deux-roues' }],
  ['depannage-auto', 'Dépannage et remorquage', 'Towing and breakdown', 'garage', 'devis', ['52.21Z'], [['Dépannage sur place', 60, 'Intervention sur le lieu de la panne.'], ['Remorquage', 90, 'Transport du véhicule au garage.'], ['Demande de devis', 15, 'Tarif selon la distance.']], { o: 'Lieu et nature de la panne', v: 'Demander un dépannage', kw: 'remorquage dépanneuse panne' }],
  ['auto-ecole', 'Auto-école', 'Driving school', 'location', 'cours', ['85.53Z'], [['Leçon de conduite', 60, 'Leçon avec un moniteur.'], ['Évaluation de départ', 60, 'Bilan avant la formation.'], ['Code de la route', 60, 'Séance de code.']], { o: 'Permis visé', kw: 'permis conduire code' }],
  ['taxi', 'Taxi et VTC', 'Taxi and private driver', 'location', 'rdv', ['49.32Z'], [['Course réservée', 30, 'Prise en charge à l’heure voulue.'], ['Transfert aéroport', 60, 'Aller ou retour.'], ['Mise à disposition', 120, 'Chauffeur à l’heure.']], { o: 'Départ, arrivée et nombre de passagers', v: 'Réserver une course', kw: 'vtc chauffeur transfert aéroport' }],
  ['location', 'Location de véhicules', 'Vehicle rental', 'location', 'sejour', ['77.11A', '77.12Z'], null, { o: 'Dates de location souhaitées', kw: 'location voiture utilitaire' }],
  ['location-bateau', 'Location de bateaux et jet-ski', 'Boat rental', 'location', 'sejour', ['77.21Z'], [['Location à la demi-journée', 240, 'Avec ou sans permis selon le bateau.'], ['Location à la journée', 480, 'Carburant selon conditions.'], ['Sortie avec pilote', 180, 'Sortie encadrée.']], { o: 'Date, durée et nombre de personnes', kw: 'bateau jet ski kayak' }],
  ['#beaute'],
  ['coiffeur', 'Salon de coiffure', 'Hair salon', 'coiffeur', 'rdv', ['96.02A'], null, { o: 'Longueur de cheveux', kw: 'coiffeuse coiffeur coiffure coupe tresses' }],
  ['barbier', 'Barbier', 'Barber', 'coiffeur', 'rdv', ['96.02A'], [['Coupe homme', 30, 'Coupe et finitions.'], ['Taille de barbe', 30, 'Taille, contours, soin.'], ['Coupe et barbe', 45, 'Forfait complet.']], { o: 'Précisions', kw: 'barber barbe' }],
  ['beaute', 'Institut de beauté', 'Beauty salon', 'beaute', 'rdv', ['96.02B'], null, { o: 'Précisions (zone, peau sensible…)', kw: 'esthéticienne esthéticien esthétique soin visage épilation' }],
  ['onglerie', 'Prothésiste ongulaire', 'Nail salon', 'beaute', 'rdv', ['96.02B'], [['Pose de gel', 90, 'Mains, couleur au choix.'], ['Remplissage', 60, 'Entretien de la pose.'], ['Semi-permanent', 45, 'Mains ou pieds.']], { o: 'Prestation et couleur souhaitées', kw: 'ongles manucure nail' }],
  ['cils-sourcils', 'Cils et sourcils', 'Lashes and brows', 'beaute', 'rdv', ['96.02B'], [['Extension de cils', 120, 'Pose cil à cil ou volume.'], ['Rehaussement de cils', 60, 'Courbure et teinture.'], ['Restructuration des sourcils', 30, 'Épilation et teinture.']], { o: 'Précisions', kw: 'cils sourcils lash' }],
  ['maquillage', 'Maquilleuse professionnelle', 'Make-up artist', 'beaute', 'rdv', ['96.02B'], [['Maquillage événement', 60, 'Soirée, photo, cérémonie.'], ['Maquillage mariée', 90, 'Essai et jour J.'], ['Cours d’automaquillage', 90, 'Apprendre les bons gestes.']], { o: 'Date et lieu de l’événement', kw: 'maquillage mariage make-up' }],
  ['spa-massage', 'Spa et massages', 'Spa and massage', 'beaute', 'rdv', ['96.04Z'], [['Massage relaxant', 60, 'Massage du corps entier.'], ['Massage duo', 60, 'Pour deux personnes.'], ['Soin du corps', 60, 'Gommage et enveloppement.']], { o: 'Préférences et contre-indications éventuelles', kw: 'massage spa bien-être hammam' }],
  ['tatouage', 'Tatouage et piercing', 'Tattoo and piercing', 'beaute', 'rdv', ['96.09Z'], [['Consultation de projet', 30, 'Échange sur le dessin et l’emplacement.'], ['Séance de tatouage', 180, 'Selon la taille du motif.'], ['Piercing', 30, 'Bijou selon le choix.']], { o: 'Description du projet', kw: 'tattoo tatoueur piercing' }],
  ['#sante'],
  ['kinesitherapeute', 'Masseur-kinésithérapeute', 'Physiotherapist', 'beaute', 'rdv', ['86.90E'], [['Séance de rééducation', 30, 'Sur prescription médicale.'], ['Premier bilan', 45, 'Évaluation et plan de soins.'], ['Séance à domicile', 45, 'Selon prescription.']], { o: 'Motif de la consultation', kw: 'kiné rééducation', sch: 'Physiotherapy' }],
  ['osteopathe', 'Ostéopathe', 'Osteopath', 'beaute', 'rdv', ['86.90F'], [['Consultation', 45, 'Adulte.'], ['Consultation enfant ou nourrisson', 45, 'Prise en charge adaptée.'], ['Consultation sportif', 45, 'Prévention et récupération.']], { o: 'Motif de la consultation', kw: 'ostéo', sch: 'MedicalBusiness' }],
  ['infirmier', 'Infirmier libéral', 'Home nurse', 'beaute', 'rdv', ['86.90D'], [['Soins à domicile', 30, 'Selon prescription.'], ['Prise de sang', 15, 'À domicile ou au cabinet.'], ['Pansement', 20, 'Selon prescription.']], { o: 'Soin et adresse', kw: 'infirmière soins domicile', sch: 'MedicalBusiness' }],
  ['psychologue', 'Psychologue', 'Psychologist', 'beaute', 'rdv', ['86.90F'], [['Consultation individuelle', 50, 'Au cabinet ou en visio.'], ['Consultation de couple', 60, 'Accompagnement à deux.'], ['Premier entretien', 50, 'Faire le point sur votre demande.']], { o: 'Motif (facultatif)', kw: 'psy thérapie', sch: 'MedicalBusiness' }],
  ['dieteticien', 'Diététicien et nutritionniste', 'Dietitian', 'beaute', 'rdv', ['86.90F'], [['Premier bilan', 60, 'Habitudes et objectifs.'], ['Consultation de suivi', 30, 'Ajustement du programme.'], ['Consultation en visio', 30, 'À distance.']], { o: 'Objectif', kw: 'nutrition diététique', sch: 'MedicalBusiness' }],
  ['orthophoniste', 'Orthophoniste', 'Speech therapist', 'beaute', 'rdv', ['86.90E'], [['Bilan orthophonique', 60, 'Sur prescription.'], ['Séance de rééducation', 30, 'Enfant ou adulte.'], ['Premier contact', 15, 'Inscription sur liste d’attente.']], { o: 'Âge et motif', kw: 'orthophonie', sch: 'MedicalBusiness' }],
  ['podologue', 'Pédicure-podologue', 'Podiatrist', 'beaute', 'rdv', ['86.90E'], [['Soin de pédicurie', 30, 'Soins des pieds.'], ['Bilan podologique', 45, 'Analyse de la marche.'], ['Semelles orthopédiques', 30, 'Prise d’empreinte et suivi.']], { o: 'Motif', kw: 'pieds semelles', sch: 'MedicalBusiness' }],
  ['sophrologue', 'Sophrologue et relaxation', 'Sophrologist', 'beaute', 'rdv', ['86.90F', '96.04Z'], [['Séance individuelle', 60, 'Respiration et relaxation.'], ['Séance de groupe', 60, 'En petit groupe.'], ['Séance en visio', 45, 'À distance.']], { o: 'Objectif', kw: 'sophrologie relaxation stress' }],
  ['naturopathe', 'Naturopathe', 'Naturopath', 'beaute', 'rdv', ['86.90F', '96.04Z'], [['Bilan de vitalité', 90, 'Premier rendez-vous.'], ['Consultation de suivi', 45, 'Ajustement des conseils.'], ['Réflexologie', 60, 'Séance de réflexologie plantaire.']], { o: 'Objectif', kw: 'naturopathie réflexologie' }],
  ['opticien', 'Opticien', 'Optician', 'commerce', 'rdv', ['47.78A'], [['Examen de vue', 30, 'Contrôle de la vue en magasin.'], ['Choix de lunettes', 45, 'Conseil et ajustage.'], ['Lentilles', 30, 'Adaptation et suivi.']], { o: 'Précisions', kw: 'lunettes lentilles optique', sch: 'Optician' }],
  ['audioprothesiste', 'Audioprothésiste', 'Hearing aid specialist', 'commerce', 'rdv', ['47.74Z'], [['Test auditif', 45, 'Bilan gratuit.'], ['Essai d’appareils', 60, 'Essai et réglages.'], ['Entretien et réglage', 30, 'Suivi de vos appareils.']], { o: 'Précisions', kw: 'audition appareil auditif' }],
  ['dentiste', 'Chirurgien-dentiste', 'Dentist', 'beaute', 'rdv', ['86.23Z'], [['Consultation', 30, 'Examen et conseils.'], ['Détartrage', 30, 'Nettoyage des dents.'], ['Urgence dentaire', 30, 'Selon disponibilité.']], { o: 'Motif', np: true, kw: 'dents cabinet dentaire', sch: 'Dentist' }],
  ['medecin', 'Médecin', 'Doctor', 'beaute', 'rdv', ['86.21Z', '86.22C'], [['Consultation', 20, 'Au cabinet.'], ['Téléconsultation', 15, 'À distance.'], ['Visite à domicile', 30, 'Selon disponibilité.']], { o: 'Motif (facultatif)', np: true, kw: 'généraliste cabinet médical', sch: 'Physician' }],
  ['veterinaire', 'Vétérinaire', 'Veterinarian', 'beaute', 'rdv', ['75.00Z'], [['Consultation', 30, 'Chiens, chats, NAC.'], ['Vaccination', 20, 'Rappels et primo-vaccination.'], ['Urgence', 30, 'Selon disponibilité.']], { o: 'Animal (espèce, âge) et motif', np: true, kw: 'véto animaux clinique', sch: 'VeterinaryCare' }],
  ['#sport'],
  ['coach-sportif', 'Coach sportif', 'Personal trainer', 'beaute', 'cours', ['85.51Z', '93.13Z'], [['Séance individuelle', 60, 'Programme personnalisé.'], ['Séance en duo', 60, 'À deux.'], ['Bilan forme', 45, 'Évaluation de départ.']], { o: 'Objectif (perte de poids, remise en forme…)', kw: 'coaching fitness musculation' }],
  ['salle-sport', 'Salle de sport et fitness', 'Gym and fitness', 'beaute', 'cours', ['93.13Z'], [['Séance d’essai', 60, 'Découverte de la salle.'], ['Cours collectif', 45, 'Selon planning.'], ['Abonnement', 30, 'Rendez-vous d’inscription.']], { o: 'Objectif', kw: 'fitness musculation crossfit' }],
  ['yoga', 'Yoga et pilates', 'Yoga and pilates', 'beaute', 'cours', ['85.51Z', '93.13Z'], [['Cours collectif', 60, 'Tous niveaux.'], ['Cours particulier', 60, 'Séance sur mesure.'], ['Cours découverte', 60, 'Première séance.']], { o: 'Niveau', kw: 'yoga pilates méditation' }],
  ['danse', 'École de danse', 'Dance school', 'beaute', 'cours', ['85.52Z'], [['Cours d’essai', 60, 'Découverte.'], ['Cours collectif', 60, 'Par niveau.'], ['Cours particulier', 60, 'Préparation ouverture de bal, spectacle.']], { o: 'Style et niveau', kw: 'danse zouk salsa kompa' }],
  ['arts-martiaux', 'Arts martiaux et sports de combat', 'Martial arts', 'beaute', 'cours', ['85.51Z'], [['Cours d’essai', 60, 'Découverte.'], ['Cours enfants', 60, 'Par âge.'], ['Cours adultes', 90, 'Tous niveaux.']], { o: 'Âge et niveau', kw: 'judo karaté boxe jiu-jitsu' }],
  ['coach-vie', 'Coach de vie et développement personnel', 'Life coach', 'beaute', 'cours', ['85.59B', '96.09Z'], [['Séance de coaching', 60, 'En présentiel ou en visio.'], ['Premier échange', 30, 'Faire le point sur vos objectifs.'], ['Atelier de groupe', 120, 'Selon programme.']], { o: 'Objectif', kw: 'coaching développement personnel' }],
  ['loisirs', 'Activités de loisirs et excursions', 'Leisure activities and tours', 'location', 'sejour', ['93.29Z', '79.90Z'], [['Excursion', 240, 'Sortie encadrée.'], ['Activité à la demi-journée', 180, 'Selon le programme.'], ['Sortie de groupe', 240, 'Sur devis.']], { o: 'Date et nombre de participants', kw: 'excursion sortie pirogue randonnée' }],
  ['#food'],
  ['restaurant', 'Restaurant', 'Restaurant', 'restaurant', 'table', ['56.10A', '56.10C'], null, { o: 'Nombre de personnes', kw: 'cuisine repas' }],
  ['food-truck', 'Food truck et snack', 'Food truck and snack bar', 'restaurant', 'commande', ['56.10C'], [['Commande à emporter', 15, 'Retrait à l’heure choisie.'], ['Réservation pour un groupe', 30, 'À partir de 10 personnes.'], ['Privatisation événement', 120, 'Sur devis.']], { o: 'Commande ou nombre de personnes', v: 'Commander', kw: 'snack burger sandwich' }],
  ['pizzeria', 'Pizzeria', 'Pizzeria', 'restaurant', 'commande', ['56.10C', '56.10A'], [['Commande à emporter', 15, 'Retrait à l’heure choisie.'], ['Réserver une table', 90, 'Sur place.'], ['Commande pour un groupe', 30, 'Événement, anniversaire.']], { o: 'Commande ou nombre de personnes', v: 'Commander', kw: 'pizza' }],
  ['traiteur', 'Traiteur', 'Caterer', 'restaurant', 'devis', ['56.21Z'], [['Buffet', 60, 'Prix par personne selon le menu.'], ['Cocktail', 60, 'Pièces salées et sucrées.'], ['Repas de mariage', 60, 'Menu sur mesure.']], { o: 'Date, lieu et nombre d’invités', v: 'Demander un devis', kw: 'cuisinier cuisinière chef à domicile buffet mariage cocktail' }],
  ['bar', 'Bar et café', 'Bar and café', 'restaurant', 'table', ['56.30Z'], [['Réserver une table', 120, 'Pour un groupe.'], ['Privatisation', 240, 'Anniversaire, afterwork.'], ['Soirée à thème', 180, 'Selon programme.']], { o: 'Nombre de personnes', kw: 'bar café lounge' }],
  ['boulangerie', 'Boulangerie et pâtisserie', 'Bakery and pastry shop', 'restaurant', 'commande', ['10.71C', '10.71D', '47.24Z'], [['Commande de gâteau', 15, 'Anniversaire, mariage, baptême.'], ['Commande de pain et viennoiseries', 10, 'Retrait le lendemain.'], ['Buffet sucré', 30, 'Pour vos événements.']], { o: 'Produits et date de retrait', v: 'Commander', kw: 'boulanger boulangère pâtissier pâtissière gâteaux pain gâteau pâtisserie' }],
  ['epicerie', 'Épicerie et alimentation générale', 'Grocery store', 'commande', 'commande', ['47.11B', '47.11C', '47.29Z'], [['Commande à retirer', 15, 'Préparée à l’avance.'], ['Livraison', 30, 'Selon secteur.'], ['Panier sur mesure', 15, 'Selon vos besoins.']], { o: 'Liste des produits', v: 'Commander', kw: 'épicerie supérette' }],
  ['boucherie', 'Boucherie et charcuterie', 'Butcher', 'commande', 'commande', ['47.22Z', '10.13B'], [['Commande à retirer', 15, 'Préparée à l’avance.'], ['Plateau pour événement', 30, 'Barbecue, buffet.'], ['Colis de viande', 15, 'Selon disponibilité.']], { o: 'Produits souhaités', v: 'Commander', kw: 'viande charcuterie' }],
  ['poissonnerie', 'Poissonnerie', 'Fishmonger', 'commande', 'commande', ['47.23Z'], [['Commande à retirer', 15, 'Selon arrivage.'], ['Plateau de fruits de mer', 30, 'Sur commande.'], ['Préparation sur demande', 15, 'Filets, darnes.']], { o: 'Produits souhaités', v: 'Commander', kw: 'poisson fruits de mer' }],
  ['glacier-chocolatier', 'Glacier et chocolatier', 'Ice cream and chocolate shop', 'commande', 'commande', ['10.52Z', '10.82Z', '47.24Z'], [['Commande de bûche ou entremets', 15, 'Selon saison.'], ['Coffret chocolats', 15, 'Cadeaux, entreprises.'], ['Glaces pour événement', 30, 'Sur commande.']], { o: 'Produits et date', v: 'Commander', kw: 'glace chocolat' }],
  ['#btp'],
  ['artisan', 'Artisan du bâtiment (multi-services)', 'Building trades', 'artisan', 'devis', ['43.22A', '43.21A', '43.22B', '43.32A'], null, { o: 'Adresse du chantier', kw: 'travaux rénovation' }],
  ['plombier', 'Plombier', 'Plumber', 'artisan', 'devis', ['43.22A'], [['Dépannage plomberie', 60, 'Fuite, canalisation bouchée.'], ['Installation sanitaire', 240, 'Salle de bain, WC, évier.'], ['Chauffe-eau', 120, 'Remplacement ou entretien.']], { o: 'Adresse et description du problème', kw: 'plomberie fuite chauffe-eau' }],
  ['electricien', 'Électricien', 'Electrician', 'artisan', 'devis', ['43.21A'], [['Dépannage électrique', 60, 'Panne, disjoncteur.'], ['Mise aux normes', 240, 'Tableau électrique, prises.'], ['Installation', 180, 'Éclairage, borne de recharge.']], { o: 'Adresse et description du problème', kw: 'électricité panne tableau' }],
  ['climatisation', 'Climatisation et froid', 'Air conditioning', 'artisan', 'devis', ['43.22B'], [['Installation de climatisation', 240, 'Monosplit ou multisplit.'], ['Entretien annuel', 60, 'Nettoyage et contrôle.'], ['Dépannage', 60, 'Panne, fuite de gaz.']], { o: 'Adresse et nombre de pièces', kw: 'clim froid frigoriste' }],
  ['macon', 'Maçon', 'Mason', 'artisan', 'devis', ['43.99C', '41.20A'], [['Visite pour devis', 60, 'Étude du projet sur place.'], ['Petits travaux de maçonnerie', 240, 'Murets, dalles, ouvertures.'], ['Construction et extension', 480, 'Sur devis.']], { o: 'Adresse et description des travaux', kw: 'maçonnerie construction dalle' }],
  ['peintre', 'Peintre en bâtiment', 'Painter and decorator', 'artisan', 'devis', ['43.34Z'], [['Visite pour devis', 45, 'Métrage et conseils.'], ['Peinture intérieure', 480, 'Murs et plafonds.'], ['Peinture extérieure', 480, 'Façades, clôtures.']], { o: 'Adresse et surfaces à peindre', kw: 'peinture façade' }],
  ['menuisier', 'Menuisier', 'Carpenter', 'artisan', 'devis', ['43.32A', '16.23Z'], [['Visite pour devis', 45, 'Prise de mesures.'], ['Pose de portes et fenêtres', 240, 'Bois, PVC, aluminium.'], ['Agencement sur mesure', 480, 'Placards, cuisines.']], { o: 'Adresse et description du projet', kw: 'menuiserie bois fenêtre' }],
  ['carreleur', 'Carreleur', 'Tiler', 'artisan', 'devis', ['43.33Z'], [['Visite pour devis', 45, 'Métrage.'], ['Pose de carrelage', 480, 'Sols et murs.'], ['Faïence salle de bain', 480, 'Pose et joints.']], { o: 'Adresse et surface', kw: 'carrelage faïence' }],
  ['couvreur', 'Couvreur', 'Roofer', 'artisan', 'devis', ['43.91B'], [['Inspection de toiture', 60, 'Diagnostic et photos.'], ['Réparation de fuite', 180, 'Tuiles, tôles, étanchéité.'], ['Réfection de toiture', 480, 'Sur devis.']], { o: 'Adresse et type de toiture', kw: 'toiture tôle étanchéité' }],
  ['charpentier', 'Charpentier', 'Framer', 'artisan', 'devis', ['43.91A'], [['Visite pour devis', 60, 'Étude du projet.'], ['Charpente', 480, 'Bois ou métal.'], ['Carport et terrasse', 480, 'Sur mesure.']], { o: 'Adresse et projet', kw: 'charpente carport' }],
  ['plaquiste', 'Plaquiste et plâtrier', 'Drywall installer', 'artisan', 'devis', ['43.31Z'], [['Visite pour devis', 45, 'Métrage.'], ['Cloisons et faux plafonds', 480, 'Plaques de plâtre.'], ['Isolation', 480, 'Murs et combles.']], { o: 'Adresse et surface', kw: 'placo isolation cloison' }],
  ['serrurier', 'Serrurier et métallier', 'Locksmith and metalworker', 'artisan', 'devis', ['43.32B', '25.11Z'], [['Ouverture de porte', 30, 'Dépannage rapide.'], ['Changement de serrure', 60, 'Toutes marques.'], ['Portail et grilles', 480, 'Fabrication sur mesure.']], { o: 'Adresse et besoin', kw: 'serrure portail ferronnerie' }],
  ['vitrier', 'Vitrier et miroitier', 'Glazier', 'artisan', 'devis', ['43.34Z'], [['Remplacement de vitre', 60, 'Toutes dimensions.'], ['Miroir sur mesure', 60, 'Découpe et pose.'], ['Vitrine', 120, 'Commerces.']], { o: 'Adresse et dimensions', kw: 'vitre miroir vitrage' }],
  ['terrassement', 'Terrassement et VRD', 'Earthworks', 'artisan', 'devis', ['43.12A'], [['Visite pour devis', 60, 'Étude du terrain.'], ['Terrassement', 480, 'Nivellement, fouilles.'], ['Assainissement', 480, 'Fosse, réseaux.']], { o: 'Adresse et projet', kw: 'terrassement nivellement' }],
  ['piscine', 'Pisciniste', 'Pool builder and maintenance', 'artisan', 'devis', ['43.99D', '81.29B'], [['Entretien de piscine', 60, 'Nettoyage, analyse de l’eau.'], ['Construction', 480, 'Sur devis.'], ['Dépannage', 60, 'Pompe, filtration.']], { o: 'Adresse et type de piscine', kw: 'piscine' }],
  ['renovation', 'Rénovation et construction', 'Renovation and construction', 'artisan', 'devis', ['41.20A', '43.39Z'], [['Visite pour devis', 60, 'Étude du projet.'], ['Rénovation intérieure', 480, 'Sur devis.'], ['Construction', 480, 'Sur devis.']], { o: 'Adresse et projet', kw: 'rénovation construction maison' }],
  ['#maison'],
  ['menage', 'Ménage et repassage', 'Cleaning and ironing', 'artisan', 'rdv', ['81.21Z', '97.00Z'], [['Ménage à domicile', 120, 'Ponctuel ou régulier.'], ['Repassage', 60, 'À domicile.'], ['Grand nettoyage', 240, 'Fin de bail, après travaux.']], { o: 'Adresse et surface', v: 'Réserver une intervention', kw: 'femme de ménage aide ménagère ménage nettoyage repassage' }],
  ['nettoyage-pro', 'Nettoyage professionnel', 'Commercial cleaning', 'securite', 'devis', ['81.22Z', '81.21Z'], [['Nettoyage de bureaux', 120, 'Ponctuel ou contrat.'], ['Nettoyage après chantier', 240, 'Sur devis.'], ['Vitrerie', 120, 'Vitres et façades.']], { o: 'Adresse, surface et fréquence', kw: 'nettoyage bureaux entretien' }],
  ['aide-domicile', 'Aide à domicile et services à la personne', 'Home care', 'artisan', 'rdv', ['88.10A', '88.10B'], [['Aide à domicile', 120, 'Courses, repas, accompagnement.'], ['Garde de nuit', 480, 'Selon besoins.'], ['Premier rendez-vous', 45, 'Évaluation des besoins.']], { o: 'Besoins et adresse', kw: 'aide personne âgée auxiliaire de vie' }],
  ['garde-enfants', 'Garde d’enfants et assistante maternelle', 'Childcare', 'artisan', 'rdv', ['88.91A', '88.91B'], [['Garde ponctuelle', 180, 'Soirée, week-end.'], ['Garde régulière', 480, 'Selon planning.'], ['Sortie d’école', 120, 'Accompagnement et goûter.']], { o: 'Âge des enfants et horaires', np: true, kw: 'nounou baby-sitting crèche' }],
  ['demenagement', 'Déménagement', 'Removals', 'location', 'devis', ['49.42Z'], [['Visite pour devis', 45, 'Estimation du volume.'], ['Déménagement', 480, 'Avec chargement et transport.'], ['Location de camion avec chauffeur', 240, 'À l’heure.']], { o: 'Adresses de départ et d’arrivée, volume', kw: 'déménageur' }],
  ['depannage-informatique', 'Dépannage informatique', 'Computer repair', 'artisan', 'rdv', ['95.11Z', '62.09Z'], [['Diagnostic', 30, 'Ordinateur, tablette.'], ['Réparation', 60, 'Logiciel ou matériel.'], ['Installation à domicile', 60, 'Box, imprimante, réseau.']], { o: 'Appareil et problème', kw: 'ordinateur réparation informatique' }],
  ['reparation-telephone', 'Réparation de téléphones', 'Phone repair', 'commande', 'rdv', ['95.12Z', '47.42Z'], [['Remplacement d’écran', 45, 'Selon modèle.'], ['Changement de batterie', 30, 'Selon modèle.'], ['Diagnostic', 15, 'Gratuit ou selon panne.']], { o: 'Modèle du téléphone et panne', kw: 'smartphone écran batterie' }],
  ['electromenager', 'Réparation d’électroménager', 'Appliance repair', 'artisan', 'devis', ['95.22Z'], [['Dépannage à domicile', 60, 'Lave-linge, réfrigérateur.'], ['Diagnostic', 30, 'Recherche de panne.'], ['Installation', 60, 'Mise en service.']], { o: 'Appareil, marque et panne', kw: 'électroménager frigo machine à laver' }],
  ['pressing', 'Pressing et blanchisserie', 'Dry cleaning and laundry', 'commande', 'commande', ['96.01B'], [['Dépôt de vêtements', 15, 'Nettoyage à sec.'], ['Linge de maison', 15, 'Couettes, rideaux.'], ['Collecte à domicile', 30, 'Selon secteur.']], { o: 'Articles à nettoyer', kw: 'pressing laverie' }],
  ['couture', 'Couture et retouches', 'Tailoring and alterations', 'commande', 'rdv', ['95.29Z', '14.13Z'], [['Retouche', 15, 'Ourlet, ajustement.'], ['Création sur mesure', 60, 'Prise de mesures.'], ['Essayage', 30, 'Ajustements.']], { o: 'Vêtement et retouche souhaitée', kw: 'couturière couturier tailleur couturière retouche' }],
  ['cordonnerie', 'Cordonnerie et clés', 'Shoe repair and key cutting', 'commande', 'commande', ['95.23Z'], [['Réparation de chaussures', 15, 'Talons, semelles.'], ['Reproduction de clés', 10, 'Clés et badges.'], ['Maroquinerie', 15, 'Réparations.']], { o: 'Article et réparation', kw: 'cordonnier clés' }],
  ['multiservices', 'Bricolage et petits travaux', 'Handyman', 'artisan', 'devis', ['81.10Z', '43.39Z'], [['Petits travaux', 120, 'Montage, fixation, réparations.'], ['Montage de meubles', 90, 'Tous types.'], ['Visite pour devis', 30, 'Sur place.']], { o: 'Adresse et travaux', kw: 'bricolage homme toutes mains' }],
  ['desinsectisation', 'Désinsectisation et dératisation', 'Pest control', 'artisan', 'devis', ['81.29A'], [['Traitement insectes', 60, 'Cafards, termites, punaises.'], ['Dératisation', 60, 'Diagnostic et traitement.'], ['Contrat d’entretien', 30, 'Professionnels.']], { o: 'Adresse et nuisibles', kw: 'termites cafards rats' }],
  ['#commerce'],
  ['fleuriste', 'Fleuriste', 'Florist', 'commande', 'commande', ['47.76Z'], [['Bouquet sur commande', 15, 'Retrait ou livraison.'], ['Fleurs de mariage', 60, 'Rendez-vous de conseil.'], ['Deuil', 15, 'Couronnes et gerbes.']], { o: 'Occasion, budget et date', v: 'Commander', kw: 'fleuriste fleurs fleurs bouquet' }],
  ['vetements', 'Boutique de vêtements', 'Clothing store', 'commande', 'commande', ['47.71Z'], [['Réserver un article', 15, 'Retrait en boutique.'], ['Conseil personnalisé', 45, 'Rendez-vous en boutique.'], ['Retouche', 15, 'Selon article.']], { o: 'Article, taille et couleur', kw: 'mode prêt-à-porter' }],
  ['bijouterie', 'Bijouterie', 'Jewellery store', 'commande', 'commande', ['47.77Z'], [['Réserver un bijou', 15, 'Retrait en boutique.'], ['Création sur mesure', 60, 'Rendez-vous.'], ['Réparation', 15, 'Selon bijou.']], { o: 'Bijou souhaité', kw: 'bijoux or montre' }],
  ['telephonie', 'Boutique de téléphonie et électronique', 'Phone and electronics store', 'commande', 'commande', ['47.42Z', '47.43Z'], [['Réserver un appareil', 15, 'Retrait en boutique.'], ['Ouverture de ligne', 30, 'Selon opérateur.'], ['Réparation', 30, 'Selon panne.']], { o: 'Appareil souhaité', kw: 'téléphone smartphone' }],
  ['quincaillerie', 'Quincaillerie et matériaux', 'Hardware store', 'commande', 'commande', ['47.52A', '47.52B'], [['Commande à retirer', 15, 'Préparée à l’avance.'], ['Devis matériaux', 30, 'Professionnels et particuliers.'], ['Livraison', 30, 'Selon secteur.']], { o: 'Liste du matériel', kw: 'bricolage matériaux outillage' }],
  ['meubles', 'Magasin de meubles et décoration', 'Furniture and home decor', 'commande', 'commande', ['47.59A', '47.59B'], [['Réserver un article', 15, 'Retrait ou livraison.'], ['Conseil déco', 60, 'Rendez-vous.'], ['Livraison et montage', 60, 'Selon secteur.']], { o: 'Article souhaité', kw: 'meuble décoration' }],
  ['cave', 'Cave à vins et spiritueux', 'Wine shop', 'commande', 'commande', ['47.25Z'], [['Commande à retirer', 15, 'Selon stock.'], ['Coffret cadeau', 15, 'Particuliers et entreprises.'], ['Dégustation', 60, 'Sur réservation.']], { o: 'Produits souhaités', np: true, kw: 'vin rhum spiritueux' }],
  ['cosmetiques', 'Parfumerie et cosmétiques', 'Perfume and cosmetics', 'commande', 'commande', ['47.75Z'], [['Réserver un produit', 15, 'Retrait en boutique.'], ['Conseil beauté', 30, 'Rendez-vous.'], ['Coffret cadeau', 15, 'Sur commande.']], { o: 'Produits souhaités', kw: 'parfum cosmétique' }],
  ['librairie', 'Librairie et papeterie', 'Bookshop and stationery', 'commande', 'commande', ['47.61Z', '47.62Z'], [['Commande de livre', 15, 'Retrait en boutique.'], ['Fournitures scolaires', 15, 'Liste préparée.'], ['Impression et reliure', 30, 'Selon demande.']], { o: 'Titres ou liste', kw: 'livres papeterie' }],
  ['animalerie', 'Animalerie', 'Pet shop', 'commande', 'commande', ['47.76Z'], [['Commande à retirer', 15, 'Alimentation, accessoires.'], ['Conseil', 30, 'Choix d’un animal.'], ['Livraison', 30, 'Selon secteur.']], { o: 'Produits souhaités', kw: 'animaux accessoires' }],
  ['#event'],
  ['photographe', 'Photographe', 'Photographer', 'artisan', 'rdv', ['74.20Z'], [['Séance photo', 60, 'Portrait, famille, studio.'], ['Reportage mariage', 480, 'Sur devis.'], ['Photo professionnelle', 60, 'Entreprises, produits.']], { o: 'Type de séance et date', kw: 'photographe photos photo shooting mariage' }],
  ['videaste', 'Vidéaste et drone', 'Videographer and drone', 'artisan', 'devis', ['59.11B', '74.20Z'], [['Film d’événement', 480, 'Mariage, anniversaire.'], ['Vidéo d’entreprise', 240, 'Présentation, réseaux sociaux.'], ['Prise de vue par drone', 120, 'Sur devis.']], { o: 'Projet et date', kw: 'vidéo drone film' }],
  ['dj-musique', 'DJ, musiciens et animation', 'DJ, musicians and entertainment', 'artisan', 'devis', ['90.01Z', '93.29Z'], [['Animation de soirée', 300, 'DJ et sonorisation.'], ['Mariage', 480, 'Cérémonie et soirée.'], ['Location de sono', 60, 'Sur devis.']], { o: 'Date, lieu et nombre d’invités', kw: 'dj sono animation musicien' }],
  ['evenementiel', 'Organisation d’événements et décoration', 'Event planning and decoration', 'artisan', 'devis', ['82.30Z', '93.29Z'], [['Premier rendez-vous', 60, 'Votre projet en détail.'], ['Décoration de salle', 240, 'Mariage, anniversaire, baptême.'], ['Organisation complète', 480, 'Sur devis.']], { o: 'Type d’événement, date et nombre d’invités', kw: 'wedding planner décoration mariage' }],
  ['location-materiel', 'Location de matériel et de salle', 'Equipment and venue hire', 'location', 'sejour', ['77.29Z', '77.39Z', '68.20B'], [['Location de salle', 480, 'Selon capacité.'], ['Location de tentes et mobilier', 60, 'Chaises, tables, barnums.'], ['Location de matériel', 60, 'Sono, éclairage.']], { o: 'Date, matériel et quantité', kw: 'location salle chapiteau' }],
  ['artiste', 'Artiste et créateur', 'Artist and maker', 'commande', 'commande', ['90.03A', '32.12Z'], [['Commande personnalisée', 30, 'Création sur mesure.'], ['Atelier', 120, 'Initiation.'], ['Visite d’atelier', 30, 'Sur rendez-vous.']], { o: 'Projet', kw: 'fabricant fabrication bougies savons céramique poterie bijoux fait main artisanat d’art créateur' }],
  ['#tourisme'],
  ['hebergement', 'Gîte, chambre d’hôtes et location saisonnière', 'Guest house and holiday rental', 'location', 'sejour', ['55.20Z'], [['Nuitée', 60, 'Selon chambre.'], ['Séjour à la semaine', 60, 'Tarif dégressif selon dates.'], ['Petit-déjeuner', 30, 'Sur demande.']], { o: 'Dates d’arrivée et de départ, nombre de personnes', kw: 'gîte chambre hôtes carbet location saisonnière', sch: 'LodgingBusiness' }],
  ['hotel', 'Hôtel', 'Hotel', 'location', 'sejour', ['55.10Z'], [['Chambre', 60, 'Selon disponibilité.'], ['Séjour affaires', 60, 'Tarifs entreprises.'], ['Salle de séminaire', 480, 'Sur devis.']], { o: 'Dates et nombre de personnes', kw: 'hôtel', sch: 'Hotel' }],
  ['agence-voyage', 'Agence de voyages', 'Travel agency', 'location', 'conseil', ['79.11Z', '79.12Z'], [['Rendez-vous conseil', 45, 'Préparer votre voyage.'], ['Devis voyage', 30, 'Billets, séjours, circuits.'], ['Voyage de groupe', 60, 'Sur devis.']], { o: 'Destination et dates', kw: 'voyage billet séjour' }],
  ['guide', 'Guide touristique', 'Tour guide', 'location', 'sejour', ['79.90Z'], [['Visite guidée', 120, 'En groupe ou en privé.'], ['Circuit à la journée', 480, 'Sur réservation.'], ['Visite sur mesure', 180, 'Sur devis.']], { o: 'Date et nombre de personnes', kw: 'visite guidée circuit' }],
  ['#formation'],
  ['soutien-scolaire', 'Soutien scolaire et cours particuliers', 'Tutoring', 'artisan', 'cours', ['85.59B'], [['Cours particulier', 60, 'Toutes matières.'], ['Aide aux devoirs', 60, 'Primaire et collège.'], ['Préparation aux examens', 90, 'Brevet, bac.']], { o: 'Niveau et matière', kw: 'cours aide aux devoirs' }],
  ['cours-musique', 'Cours de musique', 'Music lessons', 'artisan', 'cours', ['85.52Z'], [['Cours individuel', 60, 'Instrument au choix.'], ['Cours d’essai', 30, 'Découverte.'], ['Cours collectif', 60, 'Petits groupes.']], { o: 'Instrument et niveau', kw: 'musique piano guitare chant' }],
  ['langues', 'Cours de langues', 'Language lessons', 'artisan', 'cours', ['85.59B'], [['Cours particulier', 60, 'Anglais, espagnol, portugais…'], ['Cours en groupe', 90, 'Par niveau.'], ['Test de niveau', 30, 'Gratuit.']], { o: 'Langue et niveau', kw: 'anglais espagnol portugais créole' }],
  ['formation-pro', 'Organisme de formation', 'Training provider', 'artisan', 'conseil', ['85.59A'], [['Formation', 420, 'Selon programme.'], ['Rendez-vous d’information', 30, 'Financement, modalités.'], ['Formation sur mesure', 60, 'Entreprises.']], { o: 'Formation souhaitée', kw: 'formation professionnelle' }],
  ['#conseil'],
  ['comptable', 'Expert-comptable et comptabilité', 'Accountant', 'artisan', 'conseil', ['69.20Z'], [['Premier rendez-vous', 45, 'Votre situation et vos besoins.'], ['Création d’entreprise', 60, 'Statut, démarches.'], ['Tenue de comptabilité', 30, 'Sur devis.']], { o: 'Objet du rendez-vous', kw: 'comptabilité bilan fiscalité', sch: 'AccountingService' }],
  ['consultant', 'Consultant et conseil', 'Consultant', 'artisan', 'conseil', ['70.22Z'], [['Premier échange', 30, 'Diagnostic de votre besoin.'], ['Mission de conseil', 60, 'Sur devis.'], ['Accompagnement', 60, 'Suivi régulier.']], { o: 'Objet du rendez-vous', kw: 'conseil stratégie accompagnement' }],
  ['agence-web', 'Agence web et communication', 'Web and marketing agency', 'artisan', 'conseil', ['73.11Z', '62.01Z'], [['Rendez-vous projet', 45, 'Site, réseaux sociaux.'], ['Devis', 30, 'Selon projet.'], ['Maintenance', 30, 'Sur devis.']], { o: 'Projet', np: true, kw: 'communication marketing site' }],
  ['graphiste', 'Graphiste et imprimerie', 'Graphic design and printing', 'artisan', 'devis', ['74.10Z', '18.12Z'], [['Création de logo', 60, 'Identité visuelle.'], ['Impression', 30, 'Cartes, flyers, banderoles.'], ['Enseigne et marquage', 60, 'Véhicules, vitrines.']], { o: 'Projet et quantités', kw: 'logo flyer impression enseigne' }],
  ['secretariat', 'Secrétariat et services administratifs', 'Admin and office services', 'artisan', 'conseil', ['82.11Z', '82.19Z'], [['Premier rendez-vous', 30, 'Vos besoins.'], ['Secrétariat à distance', 60, 'Selon volume.'], ['Aide aux démarches', 60, 'Particuliers et entreprises.']], { o: 'Besoin', kw: 'secrétariat administratif démarches' }],
  ['traducteur', 'Traducteur et interprète', 'Translator and interpreter', 'artisan', 'devis', ['74.30Z'], [['Traduction de document', 30, 'Selon nombre de pages.'], ['Traduction assermentée', 30, 'Documents officiels.'], ['Interprétariat', 120, 'Sur devis.']], { o: 'Langues et type de document', kw: 'traduction interprète' }],
  ['assurance', 'Courtier en assurance et crédit', 'Insurance and credit broker', 'artisan', 'conseil', ['66.22Z', '66.19B'], [['Rendez-vous conseil', 45, 'Analyse de vos besoins.'], ['Devis assurance', 30, 'Auto, habitation, pro.'], ['Crédit immobilier', 60, 'Étude de financement.']], { o: 'Objet du rendez-vous', kw: 'assurance courtier crédit' }],
  ['immobilier', 'Agence immobilière', 'Real estate agency', 'artisan', 'conseil', ['68.31Z'], [['Estimation de bien', 60, 'Visite et avis de valeur.'], ['Visite d’un bien', 30, 'Sur rendez-vous.'], ['Gestion locative', 45, 'Rendez-vous conseil.']], { o: 'Bien concerné', kw: 'immobilier location vente estimation', sch: 'RealEstateAgent' }],
  ['architecte', 'Architecte et maître d’œuvre', 'Architect', 'artisan', 'conseil', ['71.11Z', '71.12B'], [['Premier rendez-vous', 60, 'Votre projet.'], ['Permis de construire', 60, 'Dossier et suivi.'], ['Suivi de chantier', 60, 'Sur devis.']], { o: 'Projet et terrain', kw: 'architecte plans permis' }],
  ['diagnostiqueur', 'Diagnostiqueur immobilier et géomètre', 'Property surveyor', 'artisan', 'devis', ['71.20B', '71.12A'], [['Diagnostics vente ou location', 120, 'DPE, électricité, amiante…'], ['Bornage', 120, 'Géomètre.'], ['Devis', 15, 'Selon le bien.']], { o: 'Adresse et type de bien', kw: 'diagnostic dpe géomètre' }],
  ['avocat', 'Avocat', 'Lawyer', 'artisan', 'conseil', ['69.10Z'], [['Consultation', 60, 'Au cabinet ou en visio.'], ['Premier rendez-vous', 30, 'Présentation de votre situation.'], ['Rédaction d’actes', 60, 'Sur devis.']], { o: 'Domaine (famille, travail…)', np: true, kw: 'juridique droit', sch: 'LegalService' }],
  ['#animaux'],
  ['toilettage', 'Toilettage', 'Pet grooming', 'beaute', 'rdv', ['96.09Z'], [['Toilettage chien', 90, 'Bain, coupe, griffes.'], ['Toilettage chat', 60, 'Selon pelage.'], ['Bain et brushing', 45, 'Petit chien.']], { o: 'Animal (race, taille)', kw: 'toiletteur toiletteuse chien chat toiletteur chien chat' }],
  ['pension-animaux', 'Pension et garde d’animaux', 'Pet boarding and sitting', 'beaute', 'sejour', ['96.09Z'], [['Pension', 60, 'À la nuitée.'], ['Garde à domicile', 60, 'Visites et promenades.'], ['Promenade', 60, 'Chiens.']], { o: 'Animal et dates', kw: 'pension chien garde animaux' }],
  ['educateur-canin', 'Éducateur canin', 'Dog trainer', 'beaute', 'cours', ['96.09Z', '85.51Z'], [['Séance d’éducation', 60, 'À domicile ou en extérieur.'], ['Bilan comportemental', 60, 'Premier rendez-vous.'], ['Cours collectif', 60, 'Chiots et adultes.']], { o: 'Chien (âge, race) et objectif', kw: 'éducation canine comportement' }],
  ['#transport'],
  ['transport', 'Transport de marchandises et livraison', 'Freight and delivery', 'location', 'devis', ['49.41B', '53.20Z'], [['Livraison', 60, 'Colis et marchandises.'], ['Transport de marchandises', 240, 'Sur devis.'], ['Course express', 60, 'Selon distance.']], { o: 'Départ, arrivée et volume', kw: 'livraison coursier transport' }],
  ['ambulance', 'Ambulance et transport sanitaire', 'Ambulance and medical transport', 'location', 'rdv', ['86.90A'], [['Transport assis', 60, 'Sur prescription.'], ['Transport allongé', 60, 'Sur prescription.'], ['Rendez-vous médical', 60, 'Aller et retour.']], { o: 'Départ, destination et date', np: true, kw: 'taxi conventionné vsl' }],
  ['#nature'],
  ['paysagiste', 'Paysagiste et jardinier', 'Landscaper and gardener', 'artisan', 'devis', ['81.30Z'], [['Entretien de jardin', 120, 'Tonte, taille, désherbage.'], ['Création d’espace vert', 480, 'Sur devis.'], ['Visite pour devis', 45, 'Sur place.']], { o: 'Adresse et surface', kw: 'jardin espaces verts tonte' }],
  ['elagage', 'Élagage et abattage', 'Tree surgeon', 'artisan', 'devis', ['02.40Z', '81.30Z'], [['Élagage', 240, 'Arbres et palmiers.'], ['Abattage', 240, 'Sécurisé.'], ['Évacuation des déchets verts', 120, 'Selon volume.']], { o: 'Adresse, nombre et hauteur des arbres', kw: 'élagueur arbre palmier' }],
  ['producteur', 'Producteur local et vente directe', 'Local producer', 'commande', 'commande', ['01.13Z', '01.24Z', '01.47Z'], [['Panier de saison', 15, 'Fruits et légumes.'], ['Commande à retirer', 15, 'À la ferme ou au marché.'], ['Livraison', 30, 'Selon secteur.']], { o: 'Produits souhaités', kw: 'ferme fruits légumes œufs miel' }],
  ['securite', 'Sécurité et gardiennage', 'Security company', 'securite', 'devis', ['80.10Z'], null, { o: 'Type de site à protéger', kw: 'gardiennage agent sécurité', cat: 'maison' }]
];

export const AUTRE = 'autre';
export const ACTIVITIES = (() => {
  const out = {}; let cat = 'auto';
  for (const row of A) {
    if (row[0].startsWith('#')) { cat = row[0].slice(1); continue; }
    const [key, fr, en, base, profile, naf, services, o = {}] = row; const P = PROFILES[profile];
    out[key] = { key, label: fr, labelEn: en, base, profile, naf, services, cat: o.cat || cat, obj: o.o || P.obj, verb: o.v || P.verb, kw: o.kw || '', np: !!o.np, sch: o.sch || null };
  }
  return out;
})();

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Recherche d'une activité à partir d'un texte libre (« toiletteuse », « plombier chauffagiste »…). */
export function matchActivity(text, { min = 6 } = {}) {
  const q = fold(text).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
  if (!q.length) return null;
  let best = null; let bestScore = 0;
  for (const a of Object.values(ACTIVITIES)) {
    const name = fold(`${a.label} ${a.key.replace(/-/g, ' ')}`); const hay = fold(`${a.labelEn} ${a.kw}`);
    let s = 0;
    for (const w of q) {
      const stem = w.length >= 5 ? w.slice(0, Math.min(6, w.length - 2)) : null;
      if (name.includes(w)) s += w.length * 2; else if (stem && name.includes(stem)) s += stem.length * 1.5;
      else if (hay.includes(w)) s += w.length; else if (stem && hay.includes(stem)) s += w.length / 2;
    }
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return bestScore >= min ? best : null;
}
const STOP = new Set(['des', 'les', 'une', 'pour', 'avec', 'sur', 'dans', 'and', 'the', 'aux', 'chez', 'mes', 'nos', 'vente', 'service', 'services', 'entreprise', 'societe', 'activite', 'domicile', 'mobile', 'independant', 'independante', 'professionnel', 'professionnelle', 'prof', 'professeur', 'professeure', 'guyane', 'martinique', 'guadeloupe', 'reunion']);

/** Libellé affiché d'une activité (ou du texte saisi pour « Autre activité »). */
export function activityLabel(key, other = '', lang = 'fr') {
  if (key === AUTRE) return String(other || '').trim().slice(0, 60) || (lang === 'en' ? 'Other activity' : 'Autre activité');
  const a = ACTIVITIES[key]; return a ? (lang === 'en' ? a.labelEn : a.label) : '';
}

// Couleur du site selon la catégorie (le professionnel peut la changer)
const CAT_COLOR = { auto: '#ffcf33', beaute: '#c58bd9', sante: '#38b2ac', sport: '#f97316', food: '#ff7a3d', btp: '#e0742e', maison: '#5b7cfa', commerce: '#ec4899', event: '#a855f7', tourisme: '#19b3a6', formation: '#3b82f6', conseil: '#475569', animaux: '#84cc16', transport: '#0ea5e9', nature: '#22c55e' };
const LEAD = {
  rdv: (l, s) => `${l}. Prenez rendez-vous en ligne en quelques secondes : ${s}.`,
  devis: (l, s) => `${l}. Demandez un devis ou une intervention en ligne : ${s}.`,
  table: (l, s) => `${l}. Réservez en ligne : ${s}.`,
  commande: (l, s) => `${l}. Commandez en ligne ou demandez un devis : ${s}.`,
  sejour: (l, s) => `${l}. Envoyez votre demande de réservation en ligne : ${s}.`,
  cours: (l, s) => `${l}. Réservez votre séance en ligne : ${s}.`,
  conseil: (l, s) => `${l}. Prenez rendez-vous en ligne pour un premier échange : ${s}.`
};
const LEAD_EN = { rdv: 'Book your appointment online in seconds.', devis: 'Request a quote or a visit online.', table: 'Book online.', commande: 'Order online or request a quote.', sejour: 'Send your booking request online.', cours: 'Book your session online.', conseil: 'Book a first meeting online.' };
const GENERIC = [['Demande de rendez-vous', 30, 'Choisissez un créneau, je vous confirme rapidement.'], ['Demande de devis', 30, 'Décrivez votre besoin, devis gratuit.'], ['Renseignements', 15, 'Une question sur mes prestations ?']];
const GENERIC_EN = { rdv: [['Appointment', 'Choose a time slot.'], ['First consultation', 'Tell us about your needs.'], ['Follow-up', 'Next appointment.']], devis: [['Quote request', 'Describe your needs, free quote.'], ['Site visit', 'We come to assess the work.'], ['Call-out', 'Repair or service.']], table: [['Table booking', 'Free booking.'], ['Group booking', 'From 8 people.'], ['Private event', 'On quotation.']], commande: [['Order to collect', 'Prepared in advance.'], ['Reservation', 'Item kept for you.'], ['Advice', 'Ask us anything.']], sejour: [['Booking request', 'Your dates and number of guests.'], ['Group booking', 'On quotation.'], ['Information', 'Ask us anything.']], cours: [['Session', 'Individual or group.'], ['Trial session', 'Discover our classes.'], ['Assessment', 'Level and goals.']], conseil: [['First meeting', 'Discuss your needs.'], ['Quote', 'On request.'], ['Follow-up', 'Ongoing support.']] };

/**
 * Modèle complet du site pour une activité du catalogue ou une activité saisie librement (« Autre activité »).
 * Les prix des prestations sont à 0 : ils ne s'affichent qu'une fois saisis et confirmés par le professionnel.
 */
export function activityTemplate(key, other = '', lang = 'fr', baseTemplates = {}) {
  let a = ACTIVITIES[key]; let label = a ? a.label : '';
  if (key === AUTRE || !a) { const m = matchActivity(other, { min: 8 }); label = activityLabel(AUTRE, other, lang); label = label.charAt(0).toUpperCase() + label.slice(1); a = m || null; }
  const base = baseTemplates[a?.base || 'artisan'] || {};
  if (a && !a.services && baseTemplates[a.key] && key !== AUTRE) { // métiers historiques : modèle complet existant
    const T = baseTemplates[a.key];
    const L = lang === 'en' ? (T.metier || a.labelEn) : a.label;
    return { ...T, label: L, metier: L, services: T.services.map(([n, , d, desc]) => [n, 0, d, desc]), activity: a.key, profile: a.profile, sch: a.sch };
  }
  const profile = a ? a.profile : 'conseil'; const P = PROFILES[profile];
  let services = a?.services || (a && baseTemplates[a.key]?.services.map(([n, , d, desc]) => [n, d, desc])) || GENERIC;
  if (lang === 'en' && (!a || a.services)) services = GENERIC_EN[profile].map(([n, d], i) => [n, services[i]?.[1] || 30, d]);
  const names = services.map((x) => x[0].toLowerCase()).join(', ');
  const metier = lang === 'en' ? (key === AUTRE || !ACTIVITIES[key] ? label : a.labelEn) : label;
  return {
    label: metier, metier, color: CAT_COLOR[a?.cat] || base.color || '#5b7cfa',
    obj: lang === 'en' ? 'Details of your request' : (a ? a.obj : P.obj), verb: lang === 'en' ? (P.verbEn || 'Book') : (a ? a.verb : P.verb),
    naf: a?.naf || [], staff: P.staff, hours: P.hours, faq: lang === 'en' ? 'Contact us for any question.' : P.faq,
    lead: lang === 'en' ? `${metier}. ${LEAD_EN[profile]}` : LEAD[profile](metier, names),
    services: services.map(([n, d, desc]) => [n, 0, d, desc]), activity: a && key !== AUTRE ? a.key : AUTRE, profile, sch: a?.sch || null
  };
}

/** Options groupées par catégorie (sélecteur de l'inscription). */
export function activityGroups(lang = 'fr') {
  return Object.entries(CATEGORIES).map(([c, C]) => ({ key: c, label: lang === 'en' ? C.en : C.fr, items: Object.values(ACTIVITIES).filter((a) => a.cat === c).map((a) => ({ key: a.key, label: lang === 'en' ? a.labelEn : a.label, kw: a.kw })).sort((x, y) => x.label.localeCompare(y.label, lang)) }));
}

/** Activité correspondant à un code NAF (les métiers historiques d'abord, puis le catalogue). */
const BASE_KEYS = ['garage', 'coiffeur', 'beaute', 'restaurant', 'securite', 'location', 'artisan'];
export function activityFromNaf(naf) {
  if (!naf) return null;
  const all = Object.values(ACTIVITIES).filter((a) => a.naf.includes(naf));
  return (all.find((a) => BASE_KEYS.includes(a.key)) || all[0] || null);
}
/** Unités de prospection des nouvelles activités : un groupe de codes NAF par activité, sans doublon, hors professions réglementées. */
export function extensionTargets(baseNafs = []) {
  const seen = new Set(baseNafs); const out = [];
  for (const a of Object.values(ACTIVITIES)) {
    if (a.np || BASE_KEYS.includes(a.key)) continue;
    const naf = a.naf.filter((n) => !seen.has(n)); if (!naf.length) continue;
    naf.forEach((n) => seen.add(n)); out.push({ activity: a.key, base: a.base, naf });
  }
  return out;
}
