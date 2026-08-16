const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("visible"));
}, { threshold: 0.12 });

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

document.querySelector("[data-copy]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.querySelector(".copy-status").textContent = "✓ copied";
  } catch {
    button.querySelector(".copy-status").textContent = "bun install && bun start";
  }
});
