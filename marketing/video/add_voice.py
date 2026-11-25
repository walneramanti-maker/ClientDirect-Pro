"""Ajoute la voix off aux vidéos déjà rendues, SANS refaire l'image (-c:v copy).

Usage : python3 add_voice.py fr voix-fr/   (un fichier par scène : nuit.wav, creer.wav, … fin.wav)
Chaque phrase démarre 0,15 s après le début de sa scène ; la musique baisse automatiquement sous la voix.
Pour l'espagnol ou le portugais : ajouter les textes dans script.py, capturer les écrans dans la langue,
puis relancer layers.cjs, render.py et ce script.
"""
import json, os, subprocess, sys

lang, vdir = sys.argv[1], sys.argv[2]
TL = json.load(open('/tmp/ad/timeline.json'))
OUT = '/tmp/ad/out'
inputs, delays = [], []
for i, sc in enumerate(TL['scenes']):
    p = os.path.join(vdir, f"{sc['key']}.wav")
    if not os.path.exists(p): sys.exit(f'Voix manquante : {p}')
    inputs += ['-i', p]
    ms = int((sc['start'] + 0.15) * 1000)
    delays.append(f'[{i + 2}:a]aresample=48000,adelay={ms}|{ms}[v{i}]')
n = len(TL['scenes'])
voice = ';'.join(delays) + ';' + ''.join(f'[v{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0,loudnorm=I=-16:TP=-1.5,apad[vo]'
for name in ('vertical-9x16', 'carre-1x1'):
    src = f'{OUT}/clientdirect-pub-{lang}-{name}.mp4'; dst = src.replace('.mp4', '-voix.mp4')
    fc = (voice + ';[vo]asplit[vo1][vo2];[1:a]volume=0.55[m];'
          '[m][vo1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[md];'
          '[md][vo2]amix=inputs=2:normalize=0,alimiter=limit=0.89[a]')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', '/tmp/ad/music.wav', *inputs,
                    '-filter_complex', fc, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                    '-shortest', '-movflags', '+faststart', dst], check=True)
    print(dst)
