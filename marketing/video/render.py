"""Encode chaque scène (un fichier par scène), assemble, ajoute la musique, écrit les sous-titres SRT."""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

TL = json.load(open('/tmp/ad/timeline.json'))
FPS = 30
LY = '/tmp/ad/layers'; SC = '/tmp/ad/scenes'; OUT = '/tmp/ad/out'
os.makedirs(SC, exist_ok=True); os.makedirs(OUT, exist_ok=True)
ENC = ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', str(FPS)]
FMTS = {'v': 'vertical-9x16', 's': 'carre-1x1'}
LANGS = ['fr', 'en']

def frames(sc):
    return round((sc['start'] + sc['dur']) * FPS) - round(sc['start'] * FPS)

def scene_job(fk, lang, sc):
    n = frames(sc); d = n / FPS
    out = f'{SC}/{fk}-{lang}-{sc["key"]}.mp4'; tmp = out[:-4] + '.tmp.mp4'
    if os.path.exists(out): return out
    still = lambda i: f'[{i}]format=rgba,loop=-1:1:0,setpts=N/{FPS}/TB,trim=end_frame={n}'
    inputs = ['-i', f'{LY}/{fk}-bg.png', '-i', f'{LY}/{fk}-{lang}-{sc["key"]}-phone.png', '-i', f'{LY}/{fk}-{lang}-{sc["key"]}-ov.png']
    f = [f'{still(0)},format=yuv420p[bg]',
         f'{still(1)}[ph]',
         f'{still(2)},fade=in:st=0.05:d=0.3:alpha=1[ov]',
         # entrée du téléphone (montée amortie) puis légère dérive vers le haut
         f"[bg][ph]overlay=x=0:y='160*pow(max(0\\,1-t/0.6)\\,3)-26*t/{d:.3f}':eval=frame[a]",
         '[a][ov]overlay=0:0[b]']
    last = 'b'
    if sc['key'] == 'fin':
        inputs += ['-i', f'{LY}/{fk}-url.png']
        f.append(f'{still(3)},fade=in:st=0.7:d=0.35:alpha=1[u]')
        f.append(f"[b][u]overlay=x=0:y='70*pow(max(0\\,1-max(0\\,t-0.7)/0.5)\\,3)':eval=frame[c]")
        last = 'c'
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', f'[{last}]', '-frames:v', str(n), *ENC, tmp]
    subprocess.run(cmd, check=True); os.replace(tmp, out)
    return out

def srt_time(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'

def write_srt(lang):
    lines = []
    for i, sc in enumerate(TL['scenes'], 1):
        a = round(sc['start'] * FPS) / FPS + 0.1; b = round((sc['start'] + sc['dur']) * FPS) / FPS - 0.1
        lines += [str(i), f'{srt_time(a)} --> {srt_time(b)}', sc['vo'][lang], '']
    open(f'{OUT}/clientdirect-pub-{lang}.srt', 'w').write('\n'.join(lines))

if __name__ == '__main__':
    only = sys.argv[1:]  # ex. "v-fr" pour ne refaire qu'une version
    jobs = [(fk, lang, sc) for fk in FMTS for lang in LANGS for sc in TL['scenes'] if not only or f'{fk}-{lang}' in only]
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda j: scene_job(*j), jobs))
    for fk, name in FMTS.items():
        for lang in LANGS:
            if only and f'{fk}-{lang}' not in only: continue
            lst = f'{SC}/{fk}-{lang}.txt'
            open(lst, 'w').write(''.join(f"file '{SC}/{fk}-{lang}-{sc['key']}.mp4'\n" for sc in TL['scenes']))
            silent = f'{SC}/{fk}-{lang}-video.mp4'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent], check=True)
            final = f'{OUT}/clientdirect-pub-{lang}-{name}.mp4'; tmp = final[:-4] + '.tmp.mp4'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', '/tmp/ad/music.wav',
                            '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], check=True)
            os.replace(tmp, final)
    for lang in LANGS: write_srt(lang)
    print('ok')
