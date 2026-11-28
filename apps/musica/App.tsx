// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Montagem do app: liga as portas do celular (armazenamento, Bluetooth, áudio, arquivos) ao controlador
// e mostra as quatro abas. A lógica fica em src/treino/controlador.ts (testada no Node).
import { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, StatusBar, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { systemClock } from "@obedient/core";
import { ClienteGrowthOs } from "./src/api/cliente.ts";
import { ControladorDoTreino } from "./src/treino/controlador.ts";
import type { FaixaCatalogo } from "@obedient/music-contracts";
import { ArquivosDoCatalogo } from "./src/catalogo/arquivos.ts";
import { CATALOGO_DEMO } from "./src/catalogo/demo.ts";
import { doGrowthOs } from "./src/catalogo/remoto.ts";
import { GROWTH_OS_URL } from "./src/config.ts";
import { prepararArquivosDemo } from "./src/plataforma/arquivos-demo.ts";
import { gerenteBlePlx } from "./src/plataforma/ble-plx.ts";
import { canalExpoAudio, prepararAudio } from "./src/plataforma/canal-expo-audio.ts";
import { kvDoAparelho } from "./src/plataforma/kv-async-storage.ts";
import { baixarComFetch, pastaDoCatalogo } from "./src/plataforma/pasta-expo.ts";
import { pedirPermissaoBluetooth } from "./src/plataforma/permissoes.ts";
import { Mixer } from "./src/player/mixer.ts";
import { procurarCintas, SensorBle } from "./src/sensor/ble.ts";
import { SensorSimuladoTempoReal } from "./src/sensor/simulado-tempo-real.ts";
import { Botao, estilos, useCores } from "./src/ui/base.tsx";
import { TelaAjustes } from "./src/ui/TelaAjustes.tsx";
import { TelaConsentimento } from "./src/ui/TelaConsentimento.tsx";
import { TelaPrivacidade } from "./src/ui/TelaPrivacidade.tsx";
import { type FontesDeSensor, TelaTreino } from "./src/ui/TelaTreino.tsx";

const ABAS = [["treino", "Treino"], ["consentimento", "Consentimento"], ["ajustes", "Ajustes"], ["privacidade", "Privacidade"]] as const;
type Aba = (typeof ABAS)[number][0];
const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function montar() {
  let uris = new Map<string, string>();
  const ble = gerenteBlePlx();
  let aoSugerir: (id: string) => void = () => undefined;
  const api = GROWTH_OS_URL ? new ClienteGrowthOs(GROWTH_OS_URL, { token: async () => null, organizacao: async () => null }) : null;
  // Catálogo real (F4): só com Growth OS e login. Sem isso, o app toca a demonstração.
  const arquivos = api ? new ArquivosDoCatalogo(pastaDoCatalogo(), api, baixarComFetch) : null;
  let catalogoReal: FaixaCatalogo[] = [];
  const mixer = new Mixer([canalExpoAudio(), canalExpoAudio()], async (id) => uris.get(id) ?? (await arquivos?.uriDe(id)) ?? null,
    { agora: Date.now, depois: (ms, f) => { const t = setTimeout(f, ms); return () => clearTimeout(t); } },
    (id) => aoSugerir(id));
  const controlador = new ControladorDoTreino({
    kv: kvDoAparelho, clock: systemClock, relogio: Date.now, player: mixer,
    catalogo: () => (catalogoReal.length ? catalogoReal : CATALOGO_DEMO.map((d) => d.faixa)),
    intervalo: (ms, f) => { const t = setInterval(f, ms); return () => clearInterval(t); },
    novoId: randomUUID,
    ...(api ? { api } : {}),
    ...(arquivos ? { apagarArquivos: () => arquivos.apagarTudo() } : {}),
  });
  aoSugerir = (id) => controlador.mostrarSugestao(id);
  const sensores: FontesDeSensor = {
    simulado: () => new SensorSimuladoTempoReal(Date.now, espera),
    async procurar() {
      if (!(await pedirPermissaoBluetooth())) return "sem_permissao";
      if (!(await ble.ligado())) return "bluetooth_desligado";
      return procurarCintas(ble, 8000, espera);
    },
    real: (id) => new SensorBle(id, ble, Date.now, espera),
  };
  const iniciar = async () => {
    await prepararAudio();
    uris = await prepararArquivosDemo();
    await controlador.carregar();
    if (api && arquivos && (await api.logado())) {
      const r = await api.catalogo();
      if (r.ok) {
        const faixas = doGrowthOs(r.dados.faixas, new Date().toISOString());
        await arquivos.atualizar(faixas);
        catalogoReal = faixas.map((f) => f.faixa);
      }
    }
  };
  return { controlador, sensores, iniciar };
}

export default function App() {
  const { controlador, sensores, iniciar } = useMemo(montar, []);
  const [aba, setAba] = useState<Aba>("treino");
  const [pronto, setPronto] = useState(false);
  // O controlador avisa a cada mudança (amostra, decisão, controle); a tela redesenha com a visão nova.
  const [, forcar] = useState(0);
  useEffect(() => controlador.aoMudar(() => forcar((n) => n + 1)), [controlador]);
  useEffect(() => { void iniciar().then(() => setPronto(true)); }, [iniciar]);
  const v = controlador.visao();
  useEffect(() => {
    if (v.emTreino) void activateKeepAwakeAsync("treino");
    else deactivateKeepAwake("treino");
  }, [v.emTreino]);
  const cores = useCores();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: cores.fundo }}>
      <StatusBar />
      <View style={[estilos.linha, { padding: 12 }]} accessibilityRole="tablist">
        {ABAS.map(([id, rotulo]) => <Botao key={id} rotulo={rotulo} tipo={aba === id ? "principal" : "comum"} aoTocar={() => setAba(id)} />)}
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {!pronto ? null
          : aba === "treino" ? <TelaTreino c={controlador} v={v} sensores={sensores} />
          : aba === "consentimento" ? <TelaConsentimento c={controlador} v={v} />
          : aba === "ajustes" ? <TelaAjustes c={controlador} v={v} />
          : <TelaPrivacidade c={controlador} />}
      </ScrollView>
    </SafeAreaView>
  );
}
