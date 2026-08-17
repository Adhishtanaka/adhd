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
    button.querySelector(".copy-status").textContent = "npm install -g adhd-cli && adhd";
  }
});

const imageLinks = [...document.querySelectorAll("a[href]")].filter((link) =>
  /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(link.getAttribute("href"))
);

if (imageLinks.length) {
  const modal = document.createElement("dialog");
  modal.className = "image-modal";
  modal.setAttribute("aria-label", "Image preview");
  modal.innerHTML = `
    <div class="image-modal-bar">
      <p><span>Image preview</span><strong></strong></p>
      <div>
        <a class="image-modal-original" target="_blank" rel="noopener">Open original ↗</a>
        <button class="image-modal-close" type="button" aria-label="Close image preview">Close ×</button>
      </div>
    </div>
    <div class="image-modal-stage"><img alt=""></div>`;
  document.body.append(modal);

  const preview = modal.querySelector("img");
  const title = modal.querySelector("strong");
  const original = modal.querySelector(".image-modal-original");
  const close = modal.querySelector(".image-modal-close");
  let trigger;

  const closeModal = () => modal.close();
  close.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => event.target === modal && closeModal());
  modal.addEventListener("close", () => {
    document.body.classList.remove("modal-open");
    trigger?.focus();
    preview.removeAttribute("src");
  });

  imageLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    trigger = link;
    const linkedImage = link.querySelector("img");
    const href = link.href;
    const description = linkedImage?.alt || "Product screenshot";
    preview.src = href;
    preview.alt = description;
    title.textContent = description;
    original.href = href;
    document.body.classList.add("modal-open");
    modal.showModal();
    close.focus();
  }));
}
