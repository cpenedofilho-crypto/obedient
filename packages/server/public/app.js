// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// O app. Três regras que governam a tela:
//   1. a tela nunca espera a rede: a ação vai para a fila do aparelho e a tela já mostra o desfecho
//      provável ("aprovado, enviando…"); quando o servidor responde, mostra o desfecho real;
//   2. tudo o que veio do agente (argumentos, motivos) entra como TEXTO (textContent), nunca como
//      HTML: é conteúdo de terceiros;
//   3. três toques no máximo: abrir, aprovar e, se a ação for sensível, a passkey.

import { copiaDoPainel, armazemIdb } from "./armazem-idb.js";
import { ArmazemEmMemoria, Fila } from "./fila.js";
import { criar, temPasskey, usar } from "./passkey.js";

/** @typedef {import("./fila.js").Op} Op */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} tag
 * @param {{ classe?: string, texto?: string, atributos?: Record<string, string> }} [o]
 * @param {(Node | null | false | undefined)[]} [filhos]
 */
function el(tag, o = {}, filhos = []) {
  const e = document.createElement(tag);
  if (o.classe) e.className = o.classe;
  if (o.texto !== undefined) e.textContent = o.texto;
  for (const [k, v] of Object.entries(o.atributos ?? {})) e.setAttribute(k, v);
  for (const f of filhos) if (f) e.append(f);
  return e;
}

/**
 * @param {string} texto
 * @param {() => void} acao
 * @param {string} [classe]
 * @param {string} [rotulo] nome acessível quando o texto sozinho não diz do quê
 */
function botao(texto, acao, classe = "botao", rotulo) {
  const b = /** @type {HTMLButtonElement} */ (el("button", { classe, texto, atributos: { type: "button", ...(rotulo ? { "aria-label": rotulo } : {}) } }));
  b.addEventListener("click", acao);
  return b;
}

const hora = (/** @type {string | number} */ iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
function falta(/** @type {string} */ iso) {
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return "venceu";
  if (min < 60) return `vence em ${min} min`;
  return `vence às ${hora(iso)}`;
}

// ------------------------------------------------------------------------------------- servidor

const POST = { method: "POST", credentials: /** @type {const} */ ("same-origin"), headers: { "content-type": "application/json", "x-obedient": "1" } };
/** @param {string} url @param {unknown} [corpo] */
async function enviarJson(url, corpo = {}) {
  const r = await fetch(url, { ...POST, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

const armazem = typeof indexedDB !== "undefined" ? armazemIdb : new ArmazemEmMemoria();
const fila = new Fila(armazem, async (op) => {
  let r;
  try {
    r = await fetch("/api/acoes", { ...POST, body: JSON.stringify({ opId: op.opId, ...op.acao }) });
  } catch {
    return { tipo: "temporaria" };
  }
  if (r.status === 200) return { tipo: "resultado", resultado: (await r.json()).resultado };
  if (r.status === 401) return { tipo: "sessao" };
  // Pedido malformado ou de fora do app: não adianta reenviar.
  if (r.status === 400 || r.status === 403) return { tipo: "resultado", resultado: { ok: false, tipo: op.acao.tipo, codigo: "invalido", mensagem: "O app não conseguiu enviar esta ação. Atualize a página." } };
  return { tipo: "temporaria" };
});

// ---------------------------------------------------------------------------------------- estado

/** @type {any} */
let painel = null;
/** @type {number | null} */
let painelDe = null; // hora da cópia local, quando o painel não veio agora do servidor
let online = navigator.onLine;
/** "confirmar liberar" aberto */
let confirmandoLiberar = false;
/** categoria sensível esperando a confirmação explícita */
let confirmandoSensivel = /** @type {string | null} */ (null);
/** "apagar tudo" esperando confirmação */
let confirmandoApagar = false;
/** entrada da trilha com o formulário de contestação aberto */
let contestando = /** @type {number | null} */ (null);

function mostrar(/** @type {"entrada" | "painel"} */ tela) {
  $("tela-entrada").hidden = tela !== "entrada";
  $("tela-painel").hidden = tela !== "painel";
}

function avisoDeConexao(/** @type {Op[]} */ pendentes) {
  const partes = [];
  if (!online) partes.push(painelDe ? `Sem internet. Mostrando o que veio às ${hora(painelDe)}.` : "Sem internet.");
  if (pendentes.length) partes.push(pendentes.length === 1 ? "1 ação esperando para enviar." : `${pendentes.length} ações esperando para enviar.`);
  $("conexao").textContent = partes.join(" ");
}

// ---------------------------------------------------------------------------------------- render

async function render() {
  if (!painel) return;
  const ops = await armazem.all();
  const pendentes = ops.filter((o) => o.estado === "pendente");
  const daProposta = (/** @type {string} */ id) => ops.filter((o) => "propostaId" in o.acao && o.acao.propostaId === id).sort((a, b) => b.criadaEm - a.criadaEm)[0];
  const daAutorizacao = (/** @type {string} */ id) => ops.filter((o) => o.acao.tipo === "revogar" && o.acao.autorizacaoId === id).sort((a, b) => b.criadaEm - a.criadaEm)[0];
  avisoDeConexao(pendentes);
  renderParada(ops);

  const lista = $("pedidos");
  lista.replaceChildren(...painel.pedidos.map((/** @type {any} */ c) => cartao(c, daProposta(c.id))));
  $("sem-pedidos").hidden = painel.pedidos.length > 0;

  const auts = $("autorizacoes");
  auts.replaceChildren(...painel.autorizacoes.map((/** @type {any} */ a) => autorizacao(a, daAutorizacao(a.id))));
  $("sem-autorizacoes").hidden = painel.autorizacoes.length > 0;

  const contestadas = new Set(painel.contestacoes.map((/** @type {any} */ c) => c.seq));
  $("atividade").replaceChildren(...painel.atividade.map((/** @type {any} */ a) => itemAtividade(a, contestadas.has(a.seq))));

  renderAprendizado(ops);
  renderDados(ops);
}

/** @param {any} a @param {boolean} jaContestada */
function itemAtividade(a, jaContestada) {
  /** @type {Node[]} */
  const filhos = [el("time", { texto: hora(a.quando), atributos: { datetime: a.quando } }), el("span", { texto: a.texto })];
  if (jaContestada) filhos.push(el("span", { classe: "selo", texto: "Contestada" }));
  else if (a.contestavel && contestando === a.seq) {
    const caixa = /** @type {HTMLTextAreaElement} */ (el("textarea", { atributos: { id: `motivo-${a.seq}`, maxlength: "1000", rows: "3", required: "" } }));
    const form = el("form", { classe: "formulario contestar" }, [
      el("label", { texto: "O que está errado?", atributos: { for: `motivo-${a.seq}` } }),
      caixa,
      el("div", { classe: "acoes" }, [
        el("button", { classe: "botao principal", texto: "Enviar contestação", atributos: { type: "submit" } }),
        botao("Cancelar", () => ((contestando = null), render()), "botao discreto"),
      ]),
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const motivo = caixa.value.trim();
      if (!motivo) return;
      contestando = null;
      void agir({ tipo: "contestar", seq: a.seq, motivo });
    });
    filhos.push(form);
    queueMicrotask(() => caixa.focus());
  } else if (a.contestavel) filhos.push(botao("Contestar", () => ((contestando = a.seq), render()), "botao discreto pequeno", `Contestar: ${a.texto}`));
  return el("li", { classe: `item ${a.tom}` }, filhos);
}

/** @param {Op[]} ops */
function renderAprendizado(ops) {
  const pendente = (/** @type {(o: Op) => boolean} */ f) => ops.some((o) => o.estado === "pendente" && f(o));
  $("categorias").replaceChildren(
    ...painel.aprendizado.categorias.map((/** @type {any} */ c) => {
      const enviando = pendente((o) => (o.acao.tipo === "ligar_aprendizado" || o.acao.tipo === "desligar_aprendizado") && o.acao.categoria === c.id);
      const nome = el("p", {}, [el("strong", { texto: c.nome }), c.sensivel ? document.createTextNode(" (dado sensível)") : null]);
      const estado = el("p", { classe: "meta", texto: enviando ? "Enviando…" : c.ligada ? "Ele pode aprender sobre isso." : "Ele não aprende sobre isso." });
      /** @type {Node} */
      let controle;
      if (enviando) controle = el("span");
      else if (c.ligada) controle = botao("Parar de aprender", () => agir({ tipo: "desligar_aprendizado", categoria: c.id }), "botao", `Parar de aprender sobre ${c.nome}`);
      else if (c.sensivel && confirmandoSensivel === c.id)
        controle = el("div", {}, [
          el("p", { classe: "ajuda", texto: `É um dado sensível. Confirme que o agente pode aprender sobre ${c.nome.toLowerCase()}.` }),
          el("div", { classe: "acoes" }, [
            botao("Sim, pode aprender", () => ((confirmandoSensivel = null), agir({ tipo: "ligar_aprendizado", categoria: c.id, especifico: true })), "botao principal"),
            botao("Não", () => ((confirmandoSensivel = null), render()), "botao discreto"),
          ]),
        ]);
      else
        controle = botao(
          "Deixar aprender",
          () => (c.sensivel ? ((confirmandoSensivel = c.id), render()) : agir({ tipo: "ligar_aprendizado", categoria: c.id })),
          "botao",
          `Deixar aprender sobre ${c.nome}`,
        );
      return el("li", { classe: "autorizacao" }, [nome, estado, controle]);
    }),
  );
  const apagando = new Set(ops.filter((o) => o.estado === "pendente" && o.acao.tipo === "esquecer").map((o) => /** @type {any} */ (o.acao).licaoId));
  const licoes = painel.aprendizado.licoes.filter((/** @type {any} */ l) => !apagando.has(l.id));
  $("licoes").replaceChildren(
    ...licoes.map((/** @type {any} */ l) =>
      el("li", { classe: "autorizacao" }, [
        el("p", { texto: l.texto }),
        el("p", { classe: "meta", texto: `${l.categoriaNome} · aprendido por ${l.agente} em ${new Date(l.quando).toLocaleDateString("pt-BR")}` }),
        botao("Apagar", () => agir({ tipo: "esquecer", licaoId: l.id }), "botao", `Apagar: ${l.texto}`),
      ]),
    ),
  );
  $("sem-licoes").hidden = licoes.length > 0;
}

/** @param {Op[]} ops */
function renderDados(ops) {
  const apagandoTudo = ops.some((o) => o.estado === "pendente" && o.acao.tipo === "apagar_tudo");
  /** @type {Node[]} */
  let apagar;
  if (apagandoTudo) apagar = [el("p", { classe: "estado", texto: "Apagando…" })];
  else if (confirmandoApagar)
    apagar = [
      el("p", { texto: "Isto apaga o que o agente aprendeu, esvazia o conteúdo dos pedidos, tira todas as autorizações e desliga todo o aprendizado. Não dá para desfazer." }),
      el("p", { classe: "ajuda", texto: "Fica guardado: o registro do que aconteceu (sem o conteúdo), o registro de que você tinha dado permissão e as suas contestações." }),
      el("div", { classe: "acoes" }, [
        botao("Sim, apagar tudo", () => ((confirmandoApagar = false), agir({ tipo: "apagar_tudo" })), "botao perigo"),
        botao("Não apagar", () => ((confirmandoApagar = false), render()), "botao discreto"),
      ]),
    ];
  else apagar = [botao("Apagar o que o OBEDIENT sabe sobre mim", () => ((confirmandoApagar = true), render()), "botao")];
  $("apagar").replaceChildren(...apagar);

  $("contestacoes").replaceChildren(
    ...painel.contestacoes.map((/** @type {any} */ c) =>
      el("li", { classe: "autorizacao" }, [
        el("p", { texto: c.motivo }),
        el("p", { classe: "meta", texto: `${c.status === "aberta" ? "Aberta" : "Respondida"} · ${new Date(c.quando).toLocaleDateString("pt-BR")}` }),
        c.resposta ? el("p", { texto: `Resposta: ${c.resposta}` }) : null,
      ]),
    ),
  );
  $("sem-contestacoes").hidden = painel.contestacoes.length > 0;
}

function renderParada(/** @type {Op[]} */ ops) {
  const caixa = $("parada");
  const ultima = ops.filter((o) => o.acao.tipo === "parar" || o.acao.tipo === "liberar").sort((a, b) => b.criadaEm - a.criadaEm)[0];
  const pendente = ultima?.estado === "pendente" ? ultima.acao.tipo : null;
  const p = painel.parada;
  /** @type {Node[]} */
  let conteudo;
  if (pendente === "parar" || (p && pendente !== "liberar")) {
    const titulo = pendente === "parar" && !p ? "Parada registrada" : "O agente está parado";
    const detalhe =
      pendente === "parar" && !p
        ? online
          ? "Enviando ao servidor…"
          : "Vai chegar ao servidor assim que este aparelho tiver internet. Enquanto isso, o agente ainda não sabe."
        : p.global
          ? `Parada geral do serviço desde ${hora(p.desde)}. Só o operador libera.`
          : `Desde ${hora(p.desde)}. Nada que ele pedir será feito até você liberar.`;
    conteudo = [el("p", { classe: "parada-titulo", texto: titulo }), el("p", { texto: detalhe })];
    if (p && !p.global && !pendente)
      conteudo.push(
        confirmandoLiberar
          ? el("div", { classe: "acoes" }, [
              botao("Sim, liberar o agente", () => agir({ tipo: "liberar" }).then(() => (confirmandoLiberar = false))),
              botao("Não, manter parado", () => ((confirmandoLiberar = false), render()), "botao discreto"),
            ])
          : botao("Liberar o agente", () => ((confirmandoLiberar = true), render()), "botao"),
      );
    caixa.className = "parada ativa";
  } else {
    conteudo = [botao("Parar o agente agora", () => agir({ tipo: "parar" }), "botao parar"), el("p", { classe: "ajuda", texto: "Um toque para tudo. Pedidos esperando são cancelados." })];
    if (pendente === "liberar") conteudo.unshift(el("p", { texto: "Liberação enviando…" }));
    caixa.className = "parada";
  }
  caixa.replaceChildren(...conteudo);
}

/** @param {any} c cartão do servidor @param {Op | undefined} op última ação local sobre ele */
function cartao(c, op) {
  const titulo = el("p", { classe: "cartao-titulo" }, [el("strong", { texto: c.agente }), document.createTextNode(" quer "), el("strong", { texto: c.acao }), document.createTextNode(` em ${c.sistema}`)]);
  const detalhes = el(
    "dl",
    { classe: "detalhes" },
    c.detalhes.flatMap((/** @type {{ campo: string, valor: string }} */ d) => [el("dt", { texto: d.campo }), el("dd", { texto: d.valor })]),
  );
  const meta = el("p", { classe: "meta" }, [el("span", { texto: c.motivo }), document.createTextNode(" · "), el("span", { texto: falta(c.venceEm) })]);
  const rotulo = `${c.acao} em ${c.sistema}`;
  /** @type {Node} */
  let rodape;
  if (op?.estado === "pendente") rodape = el("p", { classe: "estado", texto: op.acao.tipo === "aprovar" ? "Aprovado. Enviando…" : "Recusado. Enviando…" });
  else if (op?.estado === "feita") rodape = el("p", { classe: "estado bom", texto: op.acao.tipo === "aprovar" ? "Aprovado." : "Recusado." });
  else {
    const acoes = el("div", { classe: "acoes" }, [
      botao(c.exigeReautenticacao ? "Aprovar com passkey" : "Aprovar", () => aprovar(c), "botao principal", `Aprovar ${rotulo}`),
      botao("Recusar", () => agir({ tipo: "recusar", propostaId: c.id }), "botao", `Recusar ${rotulo}`),
    ]);
    rodape = el("div", {}, [
      op?.estado === "recusada" && op.resultado && !op.resultado.ok ? el("p", { classe: "erro", texto: op.resultado.mensagem, atributos: { role: "alert" } }) : null,
      c.exigeReautenticacao ? el("p", { classe: "ajuda", texto: "Ação sensível: o aparelho vai pedir para confirmar que é você." }) : null,
      acoes,
    ]);
  }
  return el("li", { classe: `cartao${c.exigeReautenticacao ? " sensivel" : ""}` }, [titulo, detalhes, meta, rodape]);
}

/** @param {any} a @param {Op | undefined} op */
function autorizacao(a, op) {
  const escopo = a.escopo;
  const limites = [
    a.semPerguntarAte ? `faz sozinho até risco ${a.semPerguntarAte}` : "sempre pergunta antes",
    `nunca acima de risco ${a.riscoMaximo}`,
    a.limiteDeValor !== null ? `até ${a.limiteDeValor.toLocaleString("pt-BR")}` : null,
    `vale até ${new Date(a.venceEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean);
  const rodape =
    op?.estado === "pendente"
      ? el("p", { classe: "estado", texto: "Retirada. Enviando…" })
      : op?.estado === "recusada" && op.resultado && !op.resultado.ok
        ? el("p", { classe: "erro", texto: op.resultado.mensagem, atributos: { role: "alert" } })
        : botao("Tirar", () => agir({ tipo: "revogar", autorizacaoId: a.id }), "botao", `Tirar a autorização de ${a.agente} para ${escopo}`);
  return el("li", { classe: "autorizacao" }, [
    el("p", {}, [el("strong", { texto: a.agente }), document.createTextNode(` pode ${escopo}`)]),
    el("p", { classe: "meta", texto: `Para: ${a.finalidade}` }),
    el("p", { classe: "meta", texto: limites.join(" · ") }),
    rodape,
  ]);
}

// ---------------------------------------------------------------------------------------- ações

/** @param {import("./fila.js").Acao} acao */
async function agir(acao) {
  await fila.registrar(acao);
  await render();
  void drenar();
}

async function drenar() {
  const r = await fila.drenar();
  if (r.parouPor === "sessao") return mostrarEntrada("Entre de novo para enviar o que ficou na fila.");
  if (r.enviadas) await atualizar();
  else await render();
}

/** @param {any} c */
async function aprovar(c) {
  if (c.exigeReautenticacao && !painel.reautenticado) {
    if (!online) return avisar("Para aprovar uma ação sensível, este aparelho precisa de internet para confirmar que é você.");
    try {
      const o = await enviarJson("/api/reautenticar/opcoes");
      if (o.status !== 200) throw new Error(o.j.mensagem ?? "não deu para confirmar");
      const r = await enviarJson("/api/reautenticar", { resposta: await usar(o.j) });
      if (r.status !== 200) throw new Error(r.j.mensagem ?? "não deu para confirmar");
      painel.reautenticado = true;
    } catch {
      return avisar("Não deu para confirmar que é você. O pedido continua esperando.");
    }
  }
  await agir({ tipo: "aprovar", propostaId: c.id, hash: c.hash });
}

function avisar(/** @type {string} */ m) {
  $("conexao").textContent = m;
}

// --------------------------------------------------------------------------------------- painel

async function atualizar() {
  try {
    const r = await fetch("/api/painel", { credentials: "same-origin" });
    if (r.status === 401) return mostrarEntrada();
    if (!r.ok) throw new Error(String(r.status));
    painel = await r.json();
    painelDe = null;
    online = true;
    await copiaDoPainel.gravar(painel).catch(() => {});
    await fila.limpar();
  } catch {
    online = false;
    if (!painel) {
      const c = await copiaDoPainel.ler().catch(() => undefined);
      if (!c) return mostrarEntrada("Sem internet. Abra o app com internet uma vez para ele funcionar sem.");
      painel = c.painel;
      painelDe = c.em;
    }
  }
  mostrar("painel");
  await render();
}

function mostrarEntrada(/** @type {string} */ m = "") {
  mostrar("entrada");
  $("erro-entrada").textContent = m;
  if (!temPasskey()) $("erro-entrada").textContent = "Este navegador não tem passkey. Use um navegador atualizado.";
}

async function entrar() {
  $("erro-entrada").textContent = "";
  try {
    const o = await enviarJson("/api/entrar/opcoes");
    const r = await enviarJson("/api/entrar", { resposta: await usar(o.j) });
    if (r.status !== 200) throw new Error();
    await atualizar();
    void drenar();
  } catch {
    $("erro-entrada").textContent = "Não deu para entrar. Tente de novo, ou use o convite se este aparelho for novo.";
  }
}

async function convite(/** @type {SubmitEvent} */ ev) {
  ev.preventDefault();
  const codigo = /** @type {HTMLInputElement} */ ($("c-codigo")).value.trim();
  $("erro-entrada").textContent = "";
  try {
    const o = await enviarJson("/api/convite/opcoes", { codigo });
    if (o.status !== 200) throw new Error();
    const r = await enviarJson("/api/convite/concluir", { codigo, resposta: await criar(o.j) });
    if (r.status !== 200) throw new Error();
    await atualizar();
  } catch {
    $("erro-entrada").textContent = "Esse convite não serviu. Confira o código ou peça um novo.";
  }
}

async function sair() {
  await enviarJson("/api/sair").catch(() => {});
  await copiaDoPainel.apagar().catch(() => {});
  painel = null;
  mostrarEntrada();
}

// ----------------------------------------------------------------------------------------- início

$("b-entrar").addEventListener("click", entrar);
$("f-convite").addEventListener("submit", convite);
$("b-sair").addEventListener("click", sair);
addEventListener("online", () => {
  online = true;
  void drenar().then(atualizar);
});
addEventListener("offline", () => {
  online = false;
  void render();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void drenar().then(atualizar);
});
setInterval(() => {
  if (document.visibilityState === "visible") void drenar().then(atualizar);
}, 20000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
void atualizar().then(drenar);
