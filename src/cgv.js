// Conditions générales de vente (clients professionnels). Texte de référence en français.
// Les mentions marquées « à compléter » sont alimentées par les variables LEGAL_* dans Render.
import { config, PLANS } from './config.js';
import { esc } from './util.js';

const eur = (n) => `${n} € HT`;

export function cgvHtml() {
  const L = config.legal; const P = PLANS;
  const plan = (k) => P[k] ? `${eur(P[k].monthly)} par mois, mise en service ${eur(P[k].setup)}` : '';
  return `
<p class="note">Version du 25 novembre 2026. Ces conditions s'appliquent aux clients professionnels uniquement (entreprises, artisans, commerçants, professions libérales). Elles sont communiquées à tout professionnel qui en fait la demande (article L. 441-1 du Code de commerce).</p>

<h2>1. Vendeur</h2>
<p>${esc(L.name)} — ${esc(L.owner)}, entrepreneur individuel (EI). SIRET ${esc(L.siret)}. Adresse : ${esc(L.address)}. Contact : ${esc(L.email || 'à compléter')}${L.phone ? `, ${esc(L.phone)}` : ''}. ${esc(L.vat)}</p>

<h2>2. Objet</h2>
<p>ClientDirect Pro est un service en ligne qui fournit au client un site Internet professionnel et, selon la formule, des demandes de devis, un bouton WhatsApp, la prise de rendez-vous en ligne, des rappels automatiques, des statistiques et un assistant automatique qui répond aux clients 24 h/24. Le contenu exact de chaque formule est décrit sur la page Tarifs au jour de la souscription.</p>

<h2>3. Formules et prix</h2>
<ul>
<li><b>Essentiel</b> : ${plan('essentiel')}.</li>
<li><b>Pro</b> : ${plan('pro')}.</li>
<li><b>Premium</b> : ${plan('premium')}.</li>
</ul>
<p>Les prix sont indiqués hors taxes. La TVA ou les taxes applicables sont ajoutées selon le lieu d'établissement du client et du vendeur. Les frais de mise en service sont payés une seule fois, avec le premier mois d'abonnement.</p>

<h2>4. Essai gratuit et souscription</h2>
<p>Le client peut essayer le service gratuitement pendant ${config.trialDays} jours, sans carte bancaire et sans engagement. Le contrat est conclu lorsque le client choisit une formule et effectue le premier paiement depuis son espace professionnel ; il reçoit alors une confirmation et une facture par e-mail.</p>

<h2>5. Durée, engagement et résiliation</h2>
<p>L'abonnement est souscrit pour une durée initiale de 12 mois à compter du premier paiement. À l'issue de cette période, il se poursuit de mois en mois et peut être résilié à tout moment, avec effet à la fin du mois en cours. La résiliation se fait depuis l'espace professionnel (« Gérer mon abonnement ») ou par écrit à l'adresse de contact. Une résiliation demandée pendant la période initiale prend effet au terme de celle-ci ; les mensualités restant dues jusqu'à ce terme restent exigibles, sauf manquement grave du vendeur.</p>
<p>Le passage à une formule supérieure est possible à tout moment ; le passage à une formule inférieure prend effet à la fin de la période d'engagement en cours.</p>

<h2>6. Paiement</h2>
<p>Paiement mensuel d'avance par carte bancaire, via le prestataire Stripe. Le vendeur ne conserve aucune donnée de carte. Factures disponibles dans l'espace professionnel.</p>
<p>En cas de retard de paiement : pénalités au taux d'intérêt de la Banque centrale européenne majoré de 10 points, et indemnité forfaitaire pour frais de recouvrement de 40 € (articles L. 441-10 et D. 441-5 du Code de commerce). Aucun escompte n'est accordé pour paiement anticipé.</p>
<p>Après un échec de paiement, le site reste en ligne ${config.graceDays} jours, puis il peut être mis en pause jusqu'à régularisation. Les données sont conservées pendant la pause.</p>

<h2>7. Obligations du vendeur</h2>
<p>Le vendeur met en ligne et héberge le site du client, assure la maintenance et les mises à jour, sauvegarde les données plusieurs fois par jour (copies chiffrées hors du serveur) et répond aux demandes d'assistance dans un délai de 2 jours ouvrés. Il est tenu à une obligation de moyens quant à la disponibilité du service ; des interruptions courtes peuvent avoir lieu pour maintenance.</p>

<h2>8. Obligations du client</h2>
<p>Le client fournit des informations exactes et à jour (prestations, prix, horaires, coordonnées) et reste seul responsable des contenus publiés, des prix pratiqués, des rendez-vous et devis qu'il accepte, ainsi que du respect des réglementations propres à son métier. Il s'interdit de publier des contenus illicites ou portant atteinte aux droits de tiers.</p>

<h2>9. Propriété intellectuelle</h2>
<p>Le client reste propriétaire de ses contenus (textes, photos, logo, marques). Le vendeur reste propriétaire du logiciel, des modèles et de la mise en page, dont il concède au client un droit d'usage pour la durée de l'abonnement. Le client autorise la mention discrète « Site réalisé avec ClientDirect Pro » en bas de son site.</p>

<h2>10. Données personnelles</h2>
<p>Pour les données des clients du professionnel, le vendeur agit comme sous-traitant au sens de l'article 28 du RGPD, selon l'accord de sous-traitance figurant dans les <a href="/cgu">conditions d'utilisation</a>. Le détail des traitements figure dans la <a href="/confidentialite">politique de confidentialité</a>.</p>

<h2>11. Responsabilité</h2>
<p>La responsabilité du vendeur est limitée aux dommages directs et prouvés, et plafonnée au montant payé par le client au cours des 12 mois précédant le fait générateur. Le vendeur n'est pas responsable des pertes de chiffre d'affaires, de clientèle ou de données causées par un tiers, une mauvaise utilisation ou une information erronée fournie par le client.</p>

<h2>12. Force majeure</h2>
<p>Aucune partie n'est responsable d'un manquement causé par un événement de force majeure au sens de l'article 1218 du Code civil (notamment panne générale d'Internet ou d'un hébergeur, catastrophe naturelle, cyclone).</p>

<h2>13. Fin du contrat et réversibilité</h2>
<p>Avant la fin du contrat, le client peut télécharger ses données depuis son espace (rendez-vous, devis, clients). Le site est mis hors ligne à la date d'effet de la résiliation ; les données sont supprimées dans les délais indiqués dans la politique de confidentialité, sauf les factures conservées 10 ans (obligation légale).</p>

<h2>14. Modification des conditions</h2>
<p>Toute modification est annoncée par e-mail au moins 30 jours avant son entrée en vigueur. Une hausse de prix n'affecte pas la période d'engagement en cours.</p>

<h2>15. Droit applicable et litiges</h2>
<p>Ces conditions sont soumises au droit français. En cas de désaccord, les parties recherchent d'abord une solution amiable. À défaut, le litige est porté devant les juridictions compétentes du ressort du siège du vendeur.</p>
`;
}
