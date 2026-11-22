// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Montagem do app: liga as portas do celular (armazenamento, cofre, Bluetooth, áudio, arquivos, links) ao
// controlador e à conta, e mostra as abas. A lógica fica em src/treino/controlador.ts e src/auth/ (testadas no Node).
import { useCallback, useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, StatusBar, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Linking from "expo-linking";
import { systemClock } from "@obedient/core";
import type { FaixaCatalogo } from "@obedient/music-contracts";
import { ClienteGrowthOs } from "./src/api/cliente.ts";
import { Conta, type EstadoConta } from "./src/auth/conta.ts";
import { FalhaLogin, SessaoSupabase } from "./src/auth/sessao.ts";
import { ArquivosDoCatalogo } from "./src/catalogo/arquivos.ts";
import { CATALOGO_DEMO } from "./src/catalogo/demo.ts";
import { doGrowthOs } from "./src/catalogo/remoto.ts";
import { GROWTH_OS_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./src/config.ts";
import { prepararArquivosDemo } from "./src/plataforma/arquivos-demo.ts";
import { gerenteBlePlx } from "./src/plataforma/ble-plx.ts";
import { canalExpoAudio, prepararAudio } from "./src/plataforma/canal-expo-audio.ts";
import { cofreSeguro } from "./src/plataforma/cofre-seguro.ts";
import { kvDoAparelho } from "./src/plataforma/kv-async-storage.ts";
import { baixarComFetch, pastaDoCatalogo } from "./src/plataforma/pasta-expo.ts";
import { pedirPermissaoBluetooth } from "./src/plataforma/permissoes.ts";
import { Mixer } from "./src/player/mixer.ts";
import { procurarCintas, SensorBle } from "./src/sensor/ble.ts";
import { SensorSimuladoTempoReal } from "./src/sensor/simulado-tempo-real.ts";
import { ControladorDoTreino } from "./src/treino/controlador.ts";
import { Botao, estilos, useCores } from "./src/ui/base.tsx";
import { TelaAjustes } from "./src/ui/TelaAjustes.tsx";
import { TelaConsentimento } from "./src/ui/TelaConsentimento.tsx";
import { type AcoesConta, TelaConta } from "./src/ui/TelaConta.tsx";
import { TelaPrivacidade } from "./src/ui/TelaPrivacidade.tsx";
import { type FontesDeSensor, TelaTreino } from "./src/ui/TelaTreino.tsx";

const ABAS = [["treino", "Treino"], ["consentimento", "Consentimento"], ["ajustes", "Ajustes"], ["privacidade", "Privacidade"], ["conta", "Conta"]] as const;
type Aba = (typeof ABAS)[number][0];
const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SEM_LOGIN = { token: async () => null, organizacao: async () => null };

function montar() {
  let uris = new Map<string, string>();
  const ble = gerenteBlePlx();
  let aoSugerir: (id: string) => void = () => undefined;
  const sessao = SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? new SessaoSupabase({ url: SUPABASE_URL, chavePublica: SUPABASE_PUBLISHABLE_KEY, cofre: cofreSeguro }) : null;
  const conta = sessao ? new Conta(sessao, kvDoAparelho) : null;
  const api = GROWTH_OS_URL ? new ClienteGrowthOs(GROWTH_OS_URL, conta ?? SEM_LOGIN) : null;
  // Catálogo real (F4): só com Growth OS e login numa organização. Sem isso, o app toca a demonstração.
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

  /** Estado da conta e, dentro de uma organização, catálogo real e envio dos resumos pendentes. */
  const atualizarDaConta = async (): Promise<EstadoConta> => {
    if (!conta || !api) return { tipo: "fora" };
    const estado = await conta.estado(api);
    if (estado.tipo === "dentro" && arquivos) {
      const r = await api.catalogo();
      if (r.ok) {
        const faixas = doGrowthOs(r.dados.faixas, new Date().toISOString());
        await arquivos.atualizar(faixas);
        catalogoReal = faixas.map((f) => f.faixa);
      }
      await controlador.enviarPendentes();
    }
    return estado;
  };

  const iniciar = async () => {
    await prepararAudio();
    uris = await prepararArquivosDemo();
    await controlador.carregar();
  };

  /** Sair: encerra a sessão e apaga as músicas baixadas da organização (a licença é dela). */
  const sair = async () => {
    await conta?.sair();
    await arquivos?.apagarTudo();
    catalogoReal = [];
  };

  return { controlador, sensores, iniciar, sessao, conta, atualizarDaConta, sair };
}

export default function App() {
  const m = useMemo(montar, []);
  const { controlador, sensores } = m;
  const [aba, setAba] = useState<Aba>("treino");
  const [pronto, setPronto] = useState(false);
  const [conta, setConta] = useState<EstadoConta>({ tipo: "fora" });
  // O controlador avisa a cada mudança (amostra, decisão, controle); a tela redesenha com a visão nova.
  const [, forcar] = useState(0);
  useEffect(() => controlador.aoMudar(() => forcar((n) => n + 1)), [controlador]);

  const atualizarConta = useCallback(async () => setConta(await m.atualizarDaConta()), [m]);

  // O link mágico do e-mail abre o app em obedient-musica://auth/confirmar?code=...
  const tratarLink = useCallback(async (url: string | null) => {
    if (!url || !m.sessao || !url.includes("auth/confirmar")) return;
    try {
      await m.sessao.concluir(url);
      setAba("conta");
    } catch (e) {
      if (!(e instanceof FalhaLogin)) throw e;
    }
    await atualizarConta();
  }, [m, atualizarConta]);

  useEffect(() => {
    void m.iniciar().then(async () => {
      setPronto(true);
      await tratarLink(await Linking.getInitialURL());
      await atualizarConta();
    });
    const assinatura = Linking.addEventListener("url", ({ url }) => void tratarLink(url));
    return () => assinatura.remove();
  }, [m, tratarLink, atualizarConta]);

  const v = controlador.visao();
  useEffect(() => {
    if (v.emTreino) void activateKeepAwakeAsync("treino");
    else deactivateKeepAwake("treino");
  }, [v.emTreino]);
  const cores = useCores();

  const acoesConta: AcoesConta = {
    async pedirLink(email) {
      if (!m.sessao) return "recusado";
      try { await m.sessao.pedirLink(email); return null; } catch (e) { return e instanceof FalhaLogin ? e.codigo : "recusado"; }
    },
    async escolher(slug) { await m.conta?.escolher(slug); await atualizarConta(); },
    async sair() { await m.sair(); setConta({ tipo: "fora" }); },
  };

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
          : aba === "privacidade" ? <TelaPrivacidade c={controlador} />
          : <TelaConta estado={conta} acoes={acoesConta} configurado={!!m.sessao && !!GROWTH_OS_URL} />}
      </ScrollView>
    </SafeAreaView>
  );
}
