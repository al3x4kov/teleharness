// FEAT-20.4. Вывод отдельного процесса входа может содержать эхо кода.
// Клиенту доступны только состояние и проверенная ссылка до отправки кода.
export class GeminiLoginOutput {
  #tail = "";
  #url;
  #status = "starting";

  get state() {
    if (this.#status === "awaiting-code") {
      return { status: this.#status, url: this.#url };
    }
    return { status: this.#status };
  }

  feed(chunk) {
    if (this.#status === "rejected") return;
    this.#tail = (this.#tail + chunk).slice(-32768);
    if (this.#status === "submitted") {
      if (this.#tail.includes("Failed to authenticate with authorization code")) {
        this.#status = "rejected";
        this.#tail = "";
      } else {
        // Для распознавания ошибки на границе чанков достаточно её префикса.
        const prefix = "Failed to authenticate with authorization code";
        let length = prefix.length - 1;
        while (length && !this.#tail.endsWith(prefix.slice(0, length))) length--;
        this.#tail = prefix.slice(0, length);
      }
      return;
    }
    const match = this.#tail.match(/https:\/\/accounts\.google\.com\/[^\s]+(?=\s)/);
    if (match) this.#url = match[0];
    if (this.#url && this.#tail.includes("Enter the authorization code:")) {
      this.#status = "awaiting-code";
      this.#tail = "";
    }
  }

  submitted() {
    if (this.#status !== "awaiting-code") throw new Error("Вход не ожидает код");
    this.#status = "submitted";
    this.#tail = "";
    this.#url = undefined;
  }
}
