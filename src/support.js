import { config } from './config.js';
import { net } from './net.js';
import { clampStr } from './util.js';
import { enqueue } from './notify.js';

// Base de connaissances : l'assistance répond d'abord avec ces fiches, puis ouvre un ticket si besoin.
export const KB = [
  { id: 'tarifs', title: 'Modifier mes prestations et mes tarifs', keys: ['tarif', 'prix', 'prestation', 'service', 'durée'], body: "Espace pro > Réglages > Prestations : modifiez le nom, le prix ou la durée, puis « Enregistrer ». Le site est mis à jour immédiatement." },
  { id: 'horaires', title: "Changer mes horaires d'ouverture", keys: ['horaire', 'ouverture', 'fermé', 'congé', 'vacances'], body: "Espace pro > Réglages > Horaires : cochez les jours ouverts et indiquez les heures. Pour des congés, décochez les jours concernés le temps de votre absence." },
  { id: 'rdv', title: 'Confirmer ou refuser un rendez-vous', keys: ['rendez', 'rdv', 'confirmer', 'refuser', 'annuler', 'réservation'], body: "Espace pro > Demandes : « Confirmer » envoie la confirmation au client par e-mail et WhatsApp (si configuré). « Refuser » le prévient et libère le créneau. Pour tout confirmer automatiquement, cochez « Confirmation automatique » dans les réglages." },
  { id: 'postes', title: 'Plusieurs rendez-vous en même temps', keys: ['poste', 'employé', 'simultané', 'même temps', 'équipe'], body: "Ajoutez un poste ou un employé par personne pouvant recevoir un client en même temps (Réglages > Postes). Le site propose alors autant de rendez-vous simultanés." },
  { id: 'paiement', title: 'Abonnement, facture, carte bancaire', keys: ['abonnement', 'facture', 'carte', 'paiement', 'prélèvement', 'résilier', 'formule'], body: "Espace pro > Abonnement > « Gérer mon abonnement » : changez de carte ou de formule, téléchargez vos factures ou résiliez. Après un échec de paiement, le site reste en ligne pendant le délai de grâce." },
  { id: 'assistant', title: "L'assistant répond-il seul ?", keys: ['assistant', 'ia', 'robot', 'chat', 'question'], get body() { return config.anthropicKey ? "Avec la formule Premium, l'assistant IA répond 24 h/24 à partir de vos prestations, tarifs, horaires et informations, et réserve dans les créneaux libres. Complétez le champ « Informations pour l'assistant » dans vos réglages." : "Votre assistant répond automatiquement 24 h/24 sur vos horaires, prestations, adresse et créneaux libres. Le mode intelligent (questions libres et réservation par l'assistant) n'est pas encore disponible. Complétez le champ « Informations pour l'assistant » dans vos réglages."; } },
  { id: 'adresse', title: 'Adresse de mon site', keys: ['adresse', 'lien', 'url', 'domaine', 'google'], body: "Votre site est disponible à l'adresse indiquée dans votre espace pro. Partagez-la sur Facebook, Google et WhatsApp." }
];

export function kbSearch(q) {
  const l = String(q).toLowerCase();
  return KB.map((a) => ({ a, s: a.keys.filter((k) => l.includes(k)).length })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.a);
}

/** Réponse automatique : fiches correspondantes, ou IA limitée à la base de connaissances si configurée. */
export async function supportAnswer(q) {
  const hits = kbSearch(q);
  if (config.anthropicKey) {
    try {
      const res = await net.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.aiModel, max_tokens: 300, system: "Tu es l'assistance de ClientDirect Pro. Réponds dans la langue de la question, en 2 à 4 phrases, uniquement à partir des fiches fournies. Si les fiches ne répondent pas, dis-le et propose d'ouvrir un ticket.\nFiches :\n" + KB.map((a) => `- ${a.title} : ${a.body}`).join('\n'), messages: [{ role: 'user', content: clampStr(q, 800) }] }) });
      if (res.ok) { const j = await res.json(); const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(); if (text) return { text, articles: hits.slice(0, 3), mode: 'ia' }; }
    } catch {}
  }
  return { text: hits.length ? hits[0].body : "Je n'ai pas trouvé de réponse dans l'aide. Ouvrez un ticket : nous vous répondons par e-mail.", articles: hits.slice(0, 3), mode: 'fiches' };
}

export function openTicket(db, { tenantId = null, userId = null, email, subject, body }) {
  const now = Date.now();
  return db.tx(() => {
    const id = Number(db.run('INSERT INTO tickets(tenant_id,user_id,email,subject,created_at,updated_at) VALUES(?,?,?,?,?,?)', tenantId, userId, clampStr(email, 190), clampStr(subject, 140) || 'Demande', now, now).lastInsertRowid);
    db.run('INSERT INTO ticket_messages(ticket_id,author,body,created_at) VALUES(?,?,?,?)', id, 'client', clampStr(body, 4000), now);
    return id;
  });
}
export function replyTicket(db, ticketId, body, author = 'admin') {
  const t = db.one('SELECT * FROM tickets WHERE id=?', ticketId); if (!t) return false;
  db.run('INSERT INTO ticket_messages(ticket_id,author,body,created_at) VALUES(?,?,?,?)', ticketId, author, clampStr(body, 4000), Date.now());
  db.run("UPDATE tickets SET status=?, updated_at=? WHERE id=?", author === 'client' ? 'open' : 'answered', Date.now(), ticketId);
  if (author !== 'client' && t.email) enqueue(db, { tenantId: t.tenant_id, channel: 'email', to: t.email, template: 'ticket_reply', payload: { subject: t.subject, body: clampStr(body, 4000), url: `${config.baseUrl}/pro/aide` } });
  return true;
}
