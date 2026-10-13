"""Monta un borrador de CapCut con CapCutAPI (pyJianYingDraft) a partir del plan del estudio.
Se ejecuta con el Python de CapCutAPI: <CAPCUT_DIR>/.venv/bin/python capcut_export.py <CAPCUT_DIR> < plan.json
plan: { name, out_dir, width, height,
        shots: [{ url, type: image|video, start, end, clip_dur?, transition? }],
        audio: [{ url, start, dur }], srt: ruta o null }
Salida (stdout, última línea): JSON { draft_id, draft_dir }
"""
import contextlib
import io
import json
import os
import sys

capcut_dir = sys.argv[1]
sys.path.insert(0, capcut_dir)
os.chdir(capcut_dir)
plan = json.load(sys.stdin)

# CapCutAPI escribe mucho por stdout: solo nuestra última línea es el resultado
log = io.StringIO()
with contextlib.redirect_stdout(log):
    from create_draft import get_or_create_draft
    from add_image_impl import add_image_impl
    from add_video_track import add_video_track
    from add_audio_track import add_audio_track
    from add_subtitle_impl import add_subtitle_impl
    from save_draft_impl import save_draft_impl

    W, H = plan["width"], plan["height"]
    draft_id, _ = get_or_create_draft(width=W, height=H)
    common = dict(draft_id=draft_id, width=W, height=H, track_name="main")
    for i, s in enumerate(plan["shots"]):
        span = max(0.1, s["end"] - s["start"])
        tr = dict(transition=s["transition"], transition_duration=0.5) if s.get("transition") else {}
        if s["type"] == "video":
            # el clip llena su hueco: si dura menos que el plano, va un poco más lento
            clip = min(s.get("clip_dur") or span, span)
            add_video_track(video_url=s["url"], start=0, end=clip, target_start=s["start"], speed=clip / span, volume=0, **common, **tr)
        else:
            add_image_impl(image_url=s["url"], start=s["start"], end=s["end"], **common, **tr)
        print(f"plano {i + 1}/{len(plan['shots'])}", file=sys.stderr, flush=True)
    for a in plan["audio"]:
        add_audio_track(audio_url=a["url"], start=0, end=a["dur"], target_start=a["start"], draft_id=draft_id, track_name="voz", volume=1.0)
    if plan.get("srt"):
        add_subtitle_impl(srt_path=plan["srt"], draft_id=draft_id, track_name="subtitulos", font_size=7.0, bold=True,
                          font_color="#FFFFFF", border_color="#000000", border_width=40.0, transform_y=-0.78, width=W, height=H)
    save_draft_impl(draft_id=draft_id, draft_folder=plan["out_dir"], project_name=plan["name"], auto_deploy=False)

print(json.dumps({"draft_id": draft_id, "draft_dir": os.path.join(plan["out_dir"], draft_id)}))
