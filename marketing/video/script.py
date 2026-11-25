"""ClientDirect Pro – texte publicitaire, scènes et minutage partagés par toutes les versions."""
import json, math

BPM = 118
BEAT = 60 / BPM
URL = "clientdirect-pro-test.onrender.com"

# (clé, capture, titre court FR, titre court EN, ligne de voix off FR, ligne EN)
SCENES = [
    ("nuit", "beaute",
     "Même la nuit,\nvotre site travaille.", "Even at night,\nyour site works.",
     "Et si votre site Internet travaillait pour vous, même pendant votre sommeil ?",
     "What if your website worked for you, even while you sleep?"),
    ("creer", "signup",
     "Votre site pro\nen quelques minutes", "Your pro website\nin minutes",
     "Avec ClientDirect Pro, créez votre site professionnel en quelques minutes.",
     "With ClientDirect Pro, create your professional website in minutes."),
    ("devis", "quote",
     "Devis et messages\nà toute heure", "Quotes and messages\nany time",
     "Recevez des demandes de devis et des messages de vos clients à toute heure.",
     "Receive quote requests and messages from your customers at any time."),
    ("rdv", "booking",
     "Formule Pro :\nrendez-vous automatiques", "Pro plan:\nautomatic bookings",
     "Avec la formule Pro, automatisez vos prises de rendez-vous.",
     "With the Pro plan, automate your bookings."),
    ("ia", "chat",
     "Premium :\nun assistant 24\u00a0h/24", "Premium:\na 24/7 assistant",
     "Avec Premium, bénéficiez d’un assistant intelligent disponible 24 heures sur 24.",
     "With Premium, get a smart assistant available 24 hours a day."),
    ("tel", "dash",
     "Tout se gère\ndepuis votre téléphone", "Run it all\nfrom your phone",
     "Gérez votre activité directement depuis votre téléphone.",
     "Manage your business straight from your phone."),
    ("temps", "dash2",
     "Moins d’administratif.\nPlus de temps pour vos clients.", "Less paperwork.\nMore time for customers.",
     "Moins de tâches administratives. Plus de temps pour vos clients.",
     "Less paperwork. More time for your customers."),
    ("partenaire", "trio",
     "Votre partenaire\ndigital", "Your digital\npartner",
     "ClientDirect Pro, votre partenaire digital.",
     "ClientDirect Pro, your digital partner."),
    ("fin", "end",
     "", "",
     "Essayez gratuitement pendant 14 jours, sans carte bancaire.",
     "Try it free for 14 days, no credit card required."),
]

def seconds_for(line):
    # voix off naturelle ~2,6 mots/s + respiration ; arrondi à 2 temps pour couper sur la musique
    w = len(line.split())
    s = max(2.8, w / 2.8 + 0.5)
    beats = math.ceil(s / BEAT / 2) * 2
    return beats * BEAT

def timeline():
    out, t = [], 0.0
    for k, cap, tfr, ten, vfr, ven in SCENES:
        d = max(seconds_for(vfr), seconds_for(ven))
        if k == "fin":
            d += 4 * BEAT  # carte finale tenue plus longtemps
        out.append(dict(key=k, cap=cap, title={"fr": tfr, "en": ten}, vo={"fr": vfr, "en": ven}, start=round(t, 3), dur=round(d, 3)))
        t += d
    return out, t

if __name__ == "__main__":
    tl, total = timeline()
    json.dump({"bpm": BPM, "total": total, "url": URL, "scenes": tl}, open("/tmp/ad/timeline.json", "w"), ensure_ascii=False, indent=1)
    for s in tl:
        print(f"{s['key']:<11} {s['start']:6.2f}  {s['dur']:5.2f}")
    print("total", round(total, 2))
