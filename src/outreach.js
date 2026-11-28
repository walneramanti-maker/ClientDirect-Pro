// Messages de prospection personnalisés : métier, besoin constaté (site absent, plateforme, site ancien), séquence de relances.
// Prospection B2B par e-mail (CNIL) : message en rapport avec l'activité du destinataire, expéditeur identifié,
// origine des données indiquée, opposition simple et gratuite (lien + réponse STOP) à chaque message.
import { config, PLANS } from './config.js';
import { isPersonName, displayName } from './prospect.js';
import { ACTIVITIES, PROFILES } from './activities.js';

/** Séquence : premier message, relance à J+4, dernière relance à J+10 ; jamais plus de 3 messages par entreprise. */
export const SEQUENCE = [{ step: 0, label: 'Premier message', delayDays: 0 }, { step: 1, label: 'Relance 1 (J+4)', delayDays: 4 }, { step: 2, label: 'Dernière relance (J+10)', delayDays: 6 }];
export const LAST_STEP = SEQUENCE.length - 1;
export const nextDelayMs = (step) => (SEQUENCE[step + 1] ? SEQUENCE[step + 1].delayDays * 864e5 : null);

// Par métier : le besoin du client final, ce que le site fait concrètement, la formule conseillée.
export const TRADES = {
  garage: {
    metier: 'garage', clients: 'vos clients',
    need: 'Un automobiliste qui cherche un garage le soir ou le week-end choisit celui où il peut réserver tout de suite.',
    does: ['prendre rendez-vous en ligne pour une vidange, des freins ou la climatisation, à toute heure', 'vous indiquer la marque, le modèle et l’année du véhicule avant de venir', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'pro', subject: (n) => `${n} : vos clients peuvent-ils réserver leur entretien en ligne ?`
  },
  coiffeur: {
    metier: 'salon de coiffure', clients: 'vos clientes et clients',
    need: 'Pendant une coupe, vous ne pouvez pas répondre au téléphone : chaque appel manqué est un rendez-vous qui part ailleurs.',
    does: ['réserver leur créneau en ligne, 24 h/24, sans vous appeler', 'choisir la prestation : coupe, tresses, couleur…', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'pro', subject: (n) => `${n} : des réservations en ligne, même pendant vos coupes`
  },
  beaute: {
    metier: 'institut de beauté', clients: 'vos clientes',
    need: 'Pendant un soin, vous ne pouvez pas répondre au téléphone : chaque appel manqué est un rendez-vous qui part ailleurs.',
    does: ['réserver leur soin en ligne, 24 h/24, sans vous appeler', 'préciser leurs besoins avant de venir', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'pro', subject: (n) => `${n} : des réservations en ligne, même pendant vos soins`
  },
  restaurant: {
    metier: 'restaurant', clients: 'vos clients',
    need: 'Beaucoup de clients choisissent où manger sur leur téléphone, souvent au dernier moment.',
    does: ['réserver une table en ligne en indiquant le nombre de personnes', 'vous demander un devis pour un groupe ou un événement', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'pro', subject: (n) => `${n} : la réservation de table en ligne, sans commission`
  },
  securite: {
    metier: 'entreprise de sécurité', clients: 'vos clients professionnels',
    need: 'Une entreprise qui cherche un prestataire de gardiennage compare d’abord en ligne, puis demande des devis.',
    does: ['vous demander un devis en précisant le type de site à protéger', 'prendre rendez-vous avec un responsable', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'essentiel', subject: (n) => `${n} : recevoir des demandes de devis qualifiées`
  },
  location: {
    metier: 'loueur de véhicules', clients: 'vos clients',
    need: 'Un voyageur réserve souvent son véhicule avant d’arriver, depuis son téléphone.',
    does: ['réserver un créneau de retrait en ligne, avec les dates souhaitées', 'découvrir vos véhicules disponibles', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'pro', subject: (n) => `${n} : des réservations de véhicules en ligne`
  },
  artisan: {
    metier: 'artisan', clients: 'vos clients',
    need: 'Sur un chantier, vous ne pouvez pas toujours décrocher : un client qui ne vous joint pas appelle le suivant.',
    does: ['vous envoyer une demande de devis avec l’adresse du chantier et une description', 'prendre rendez-vous pour une visite', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    plan: 'essentiel', subject: (n) => `${n} : recevoir vos demandes de devis même sur le chantier`
  }
};
// Nouvelles activités : arguments du profil (rendez-vous, devis, commande…) avec le nom réel du métier
const SUBJECT = { rdv: 'vos clients peuvent-ils prendre rendez-vous en ligne ?', devis: 'recevoir vos demandes de devis en ligne, même quand vous êtes occupé', table: 'la réservation en ligne, sans commission', commande: 'vos clients peuvent commander ou réserver en ligne', sejour: 'des demandes de réservation en ligne', cours: 'des réservations de séances en ligne', conseil: 'des prises de rendez-vous en ligne' };
// Activités dont l'argument du profil générique ne correspond pas au métier réel
const PITCH = {
  traiteur: { need: 'Pour un mariage, un anniversaire ou un repas d’entreprise, vos clients cherchent un traiteur en ligne et demandent plusieurs devis.',
    does: ['vous demander un devis avec la date et le nombre d’invités', 'découvrir vos formules : buffet, cocktail, repas', 'vous écrire sur WhatsApp, dès que vous ajoutez votre numéro'],
    subject: 'recevoir vos demandes de devis pour vos événements' }
};
const tradeOf = (p) => {
  const a = p.activity && ACTIVITIES[p.activity];
  if (!a || (TRADES[a.key] && !a.services)) return TRADES[p.tpl] || TRADES.artisan;
  const P = PROFILES[a.profile];
  const X = PITCH[a.key] || {};
  return { metier: a.label.toLowerCase(), clients: 'vos clients', need: X.need || P.need, does: X.does || P.does, plan: P.plan, subject: (n) => `${n} : ${X.subject || SUBJECT[a.profile]}` };
};

/** Constat sur la présence en ligne : formulé prudemment, jamais affirmé sans vérification. */
export function needLine(p) {
  let f = {}; try { f = JSON.parse(p.site_flags || '{}'); } catch { f = {}; }
  const st = p.site_status || (p.website ? null : 'aucun_probable');
  if (st === 'aucun') return 'Je n’ai pas trouvé de site Internet à votre nom.';
  if (st === 'aucun_probable') return 'Je n’ai pas trouvé de site Internet à votre nom.';
  if (st === 'plateforme') return 'Vous êtes visible sur une plateforme ou un réseau social, mais pas encore sur un site à votre nom.';
  if (st === 'vieillissant' || st === 'récent') {
    const miss = [!f.booking && 'la réservation en ligne', !f.quote && 'la demande de devis en ligne'].filter(Boolean);
    return miss.length ? `Votre site actuel ne propose pas encore ${miss.join(' ni ')}.` : 'Votre site actuel a déjà l’essentiel ; l’assistant qui répond à vos clients 24 h/24 pourrait vous faire gagner du temps.';
  }
  return '';
}
const planOf = (p) => { const t = tradeOf(p); const st = p.site_status; return (st === 'vieillissant' || st === 'récent') && !needLine(p).includes('pas encore') ? 'premium' : t.plan; };
const eur = (v) => `${v} €`;
export function planLine(p) {
  const pl = PLANS[planOf(p)];
  return `Ensuite, seulement si vous le décidez : formule ${pl.name}, ${eur(pl.monthly)} HT/mois + ${eur(pl.setup)} HT de mise en service, engagement de 12 mois. Formules dès ${eur(PLANS.essentiel.monthly)} HT/mois : ${config.baseUrl}/#formules`;
}
export const trialUrl = (p, token) => `${config.baseUrl}/inscription?claim=${token}&formule=${planOf(p)}`;

function legalFooter(stopUrl) {
  const L = config.legal;
  return `${L.owner}\nFondateur de ClientDirect Pro${L.phone ? ` · ${L.phone}` : ''}\n\n—\n${L.name}, SIRET ${L.siret}. Vos coordonnées professionnelles proviennent du registre public des entreprises (INSEE) et de votre fiche publique ; elles servent uniquement à vous présenter ce service et sont conservées 36 mois au plus. Accès, rectification ou suppression : répondez à ce message. Pour ne plus recevoir aucun message et supprimer l'exemple : ${stopUrl} (ou répondez STOP).`;
}

/**
 * Message e-mail d'une étape de la séquence. p : prospect ; name : nom affiché ; demoUrl, token, stopUrl : liens personnels.
 * Retourne { subject, text }.
 */
export function sequenceEmail(p, { name, demoUrl, token, stopUrl, step = 0 }) {
  const T = tradeOf(p);
  // Nom d'une personne (entreprise individuelle sans enseigne) : on parle de « votre salon de coiffure à Rouen »
  if (isPersonName(name)) { const city = p.city ? displayName(p.city) : ''; const lieu = `votre ${T.metier}${city ? ` à ${city}` : ''}`; return personal(sequenceEmail({ ...p }, { name: '\u0000', demoUrl, token, stopUrl, step }), lieu); } const trial = trialUrl(p, token); const days = config.trialDays;
  const essai = `Essai gratuit de ${days} jours, sans carte bancaire et sans engagement : si le site ne vous convient pas, vous n'avez rien à faire, rien ne vous sera facturé.`;
  const Cl = T.clients[0].toUpperCase() + T.clients.slice(1);
  if (step === 0) {
    const nl = needLine(p);
    return {
      subject: T.subject(name),
      text: `Bonjour,\n\n${T.need}${nl ? ` ${nl}` : ''}\n\nJ'ai donc préparé gratuitement un exemple de site pour ${name} (démonstration non officielle, lien personnel, non référencée sur Google) :\n${demoUrl}\n\n${Cl} pourraient y :\n- ${T.does.join('\n- ')}\n\nChaque demande vous arrive par e-mail et dans votre espace, sur votre téléphone.\n\n${essai}\nActiver l'essai en 2 minutes :\n${trial}\n\n${planLine(p)}\n\nUne question, ou une présentation de 10 minutes par téléphone ou en visio ? Répondez simplement à ce message.\n\nBien cordialement,\n${legalFooter(stopUrl)}`
    };
  }
  if (step === 1) {
    return {
      subject: `Re: ${T.subject(name)}`,
      text: `Bonjour,\n\nAvez-vous pu regarder l'exemple de site préparé pour ${name} ?\n${demoUrl}\n\n${Cl} pourraient y ${T.does[0]}, et vous recevriez chaque demande sur votre téléphone.\n\n${essai}\n${trial}\n\nBien cordialement,\n${legalFooter(stopUrl)}`
    };
  }
  return {
    subject: `Re: ${T.subject(name)}`,
    text: `Bonjour,\n\nC'est mon dernier message : je ne vous relancerai plus.\n\nL'exemple de site pour ${name} reste disponible quelques semaines :\n${demoUrl}\n\nSi le moment est mal choisi, vous pourrez l'activer plus tard, avec le même essai gratuit de ${days} jours, sans carte bancaire :\n${trial}\n\nMerci pour votre temps et bonne continuation.\n${legalFooter(stopUrl)}`
  };
}

/** Remplace le nom par « votre <métier> à <ville> », en début de phrase avec une majuscule. */
function personal(m, lieu) {
  const cap = lieu[0].toUpperCase() + lieu.slice(1);
  return { subject: m.subject.replace(/^(Re: )?\u0000/, (x, re) => `${re || ''}${cap}`), text: m.text.replace(/\u0000/g, lieu) };
}
/** SMS (si un jour autorisé) : court, identifié, avec STOP. */
export function sequenceSms(p, { name, demoUrl, stopUrl }) {
  return `Bonjour, ${config.legal.owner} de ClientDirect Pro. Exemple de site gratuit préparé pour ${name} : ${demoUrl} (démo non officielle). Essai ${config.trialDays} j gratuit, sans carte bancaire. Plus de message : STOP ou ${stopUrl}`;
}

/** Script d'appel personnalisé (jamais envoyé : aide pour la personne qui appelle). */
export function callPitch(p, { name, demoUrl }) {
  const T = tradeOf(p); const nl = needLine(p);
  return `« Bonjour, ${config.legal.owner}, de ClientDirect Pro. Je vous appelle au sujet de votre ${T.metier} ; vous avez deux minutes ? ${T.need}${nl ? ` ${nl}` : ''} J'ai préparé gratuitement un exemple de site pour ${name} : ${T.clients} peuvent y ${T.does[0]}. Vous pouvez l'essayer ${config.trialDays} jours gratuitement, sans carte bancaire. Je vous envoie le lien par SMS ou par e-mail ? » — Si oui : envoyer ${demoUrl}. — Si non : « Très bien, je ne vous rappellerai pas » et noter « Ne veut plus être contacté » (opposition enregistrée définitivement). — Si la personne demande d'où vient son numéro : « De sources publiques : le registre des entreprises et votre fiche d'établissement en ligne. Vous pouvez vous opposer à tout moment, je le note tout de suite. » — Ne jamais rappeler plus de 2 fois sans réponse ; appeler en semaine, de 9 h à 18 h (heure locale du prospect).`;
}
