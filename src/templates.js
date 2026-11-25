// Modèles de métier : une nouvelle entreprise est générée à partir de l'un d'eux, sans développement.
// hours : jour (0 = dimanche) -> [ouverture, fermeture] ; services : [nom, prix à partir de, durée min, description]
const H = (wk, sat = null, sun = null) => ({ 1: wk, 2: wk, 3: wk, 4: wk, 5: wk, 6: sat, 0: sun });
export const TEMPLATES = {
  garage: {
    label: 'Garage automobile', metier: 'Garage automobile', color: '#ffcf33', obj: 'Véhicule (marque, modèle, année)', verb: 'Prendre rendez-vous',
    naf: ['45.20A', '45.20B'], staff: ['Pont 1', 'Pont 2'], hours: H(['07:30', '17:30'], ['08:00', '12:00']),
    lead: 'Entretien, freins, climatisation, batterie. Réservez en ligne ou posez vos questions à notre assistant, même le soir.',
    faq: 'Paiement par carte, espèces ou virement. Pièces facturées selon le véhicule. Devis gratuit.',
    services: [['Vidange et filtres', 79, 60, 'Huile, filtre à huile, contrôle des niveaux.'], ['Plaquettes de frein avant', 89, 90, 'Remplacement et contrôle des disques.'], ['Recharge climatisation', 69, 60, "Recharge du gaz et test d'étanchéité."], ['Batterie et démarrage', 35, 30, 'Test, remplacement, dépannage.'], ['Diagnostic électronique', 49, 45, 'Lecture des codes défaut.']]
  },
  coiffeur: {
    label: 'Coiffeur', metier: 'Salon de coiffure', color: '#f28fb5', obj: 'Longueur de cheveux', verb: 'Réserver',
    naf: ['96.02A'], staff: ['Coiffeuse 1', 'Coiffeuse 2'], hours: { 1: null, 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '19:00'], 6: ['08:00', '17:00'], 0: null },
    lead: 'Coupes, tresses, couleurs et soins. Réservez votre créneau en ligne, sans attendre au téléphone.',
    faq: "Paiement par carte ou espèces. Merci de prévenir 24 h à l'avance en cas d'annulation.",
    services: [['Coupe homme', 15, 30, 'Coupe et finitions.'], ['Coupe femme et brushing', 35, 60, 'Shampooing, coupe, brushing.'], ['Tresses', 80, 180, 'Selon la longueur, mèches non comprises.'], ['Couleur', 45, 90, 'Couleur complète et soin.']]
  },
  restaurant: {
    label: 'Restaurant', metier: 'Restaurant', color: '#ff7a3d', obj: 'Nombre de personnes', verb: 'Réserver une table',
    naf: ['56.10A', '56.10C'], staff: ['Table A', 'Table B', 'Table C', 'Table D'], hours: H(['11:30', '14:30'], ['11:30', '22:00']),
    lead: 'Cuisine maison, midi et soir. Réservez votre table ou demandez un devis traiteur.',
    faq: 'Plats à emporter possibles. Paiement par carte ou espèces.',
    services: [['Table pour 2', 0, 90, 'Réservation sans frais.'], ['Table pour 4', 0, 90, 'Réservation sans frais.'], ['Traiteur événement', 18, 60, 'Prix par personne, à partir de 20 personnes.']]
  },
  securite: {
    label: 'Entreprise de sécurité', metier: 'Entreprise de sécurité', color: '#5b7cfa', obj: 'Type de site à protéger', verb: 'Prendre rendez-vous pour un devis',
    naf: ['80.10Z'], staff: ['Responsable commercial'], hours: H(['08:00', '17:00']),
    lead: "Gardiennage, rondes, sécurité d'événements. Demandez un devis ou un rendez-vous avec un responsable.",
    faq: 'Agents titulaires de la carte professionnelle. Devis gratuit.',
    services: [['Rendez-vous devis gardiennage', 0, 45, 'Visite ou appel avec un responsable.'], ['Agent événementiel (par heure)', 28, 60, 'Prix par heure et par agent, à partir de.'], ['Audit de sécurité de site', 250, 120, 'Visite et rapport écrit.']]
  },
  location: {
    label: 'Location de véhicules', metier: 'Location de véhicules', color: '#19b3a6', obj: 'Dates de location souhaitées', verb: 'Réserver un retrait',
    naf: ['77.11A', '77.12Z'], staff: ['Comptoir 1', 'Comptoir 2'], hours: H(['07:00', '18:00'], ['08:00', '13:00'], ['08:00', '11:00']),
    lead: "Citadines, utilitaires et 4x4. Réservez l'heure de retrait de votre véhicule en ligne.",
    faq: 'Permis de plus de 2 ans et dépôt de garantie demandés. Paiement par carte.',
    services: [['Retrait citadine (par jour)', 35, 30, 'Kilométrage illimité, à partir de.'], ['Retrait utilitaire (par jour)', 79, 30, 'À partir de.'], ['Retrait 4x4 pick-up (par jour)', 95, 30, 'À partir de.']]
  },
  artisan: {
    label: 'Artisan du bâtiment', metier: 'Artisan du bâtiment', color: '#e0742e', obj: 'Adresse du chantier', verb: 'Prendre rendez-vous',
    naf: ['43.22A', '43.21A', '43.22B', '43.32A'], staff: ['Équipe 1'], hours: H(['07:00', '16:00']),
    lead: 'Plomberie, électricité, petits travaux. Réservez une intervention ou une visite pour devis.',
    faq: 'Assurance décennale. Paiement par virement ou chèque.',
    services: [['Visite pour devis', 0, 60, 'Déplacement et devis gratuits sur la commune.'], ['Dépannage plomberie', 65, 60, 'À partir de.'], ['Dépannage électricité', 65, 60, 'À partir de.']]
  }
};
export const tplFromNaf = (naf) => Object.entries(TEMPLATES).find(([, t]) => t.naf.includes(naf))?.[0] || null;
