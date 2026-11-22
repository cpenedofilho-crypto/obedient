// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// CanalAudio (player/mixer.ts) sobre o expo-audio. Só carregar, tocar, pausar e volume: a taxa de
// reprodução e o tom nunca são tocados (D31: o áudio não é alterado).
import { type AudioPlayer, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { CanalAudio } from "../player/mixer.ts";

export async function prepararAudio(): Promise<void> {
  await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "duckOthers" });
}

export function canalExpoAudio(): CanalAudio {
  let player: AudioPlayer | null = null;
  let aoFim: (() => void) | null = null;
  return {
    async carregar(uri) {
      if (!player) {
        player = createAudioPlayer({ uri });
        player.addListener("playbackStatusUpdate", (s) => { if (s.didJustFinish) aoFim?.(); });
      } else player.replace({ uri });
    },
    tocar() { player?.play(); },
    pausar() { player?.pause(); },
    volume(v) { if (player) player.volume = Math.max(0, Math.min(1, v)); },
    aoTerminar(f) { aoFim = f; },
  };
}
