export interface ApiServiceOptions {
  baseUrl?: string;
  credentials?: RequestCredentials;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export class ApiNetworkError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ApiNetworkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApiAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ApiAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ApiHttpError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApiService {
  private readonly baseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: ApiServiceOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.credentials = options.credentials ?? "omit";
    this.defaultHeaders = {
      Accept: "application/json",
      ...options.defaultHeaders,
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async get<T>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    return this.request<T>(url, { method: "GET" });
  }

  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(endpoint);
    const headers: Record<string, string> = { ...this.defaultHeaders };
    let requestBody: BodyInit | undefined;

    if (body !== undefined) {
      if (
        typeof body === "string" ||
        body instanceof FormData ||
        body instanceof URLSearchParams
      ) {
        requestBody = body;
      } else {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }
    }

    return this.request<T>(url, {
      method: "POST",
      headers,
      body: requestBody,
    });
  }

  private buildUrl(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ): string {
    let base: string;
    if (/^https?:\/\//i.test(endpoint)) {
      base = endpoint;
    } else if (this.baseUrl) {
      if (this.baseUrl.endsWith("/") && endpoint.startsWith("/")) {
        base = `${this.baseUrl}${endpoint.slice(1)}`;
      } else if (!this.baseUrl.endsWith("/") && !endpoint.startsWith("/")) {
        base = `${this.baseUrl}/${endpoint}`;
      } else {
        base = `${this.baseUrl}${endpoint}`;
      }
    } else {
      base = endpoint;
    }

    if (!params || Object.keys(params).length === 0) return base;

    const url = new URL(
      base,
      /^https?:\/\//i.test(base) ? undefined : "http://localhost",
    );
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return /^https?:\/\//i.test(base)
      ? url.toString()
      : `${url.pathname}${url.search}`;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        credentials: this.credentials,
        headers: {
          ...this.defaultHeaders,
          ...init.headers,
        },
        signal: controller.signal,
      });

      let responseData: unknown;
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (
        contentType.includes("application/json") ||
        (!contentType && typeof response.json === "function")
      ) {
        try {
          responseData = await response.json();
        } catch {
          if (typeof response.text === "function") {
            try {
              responseData = await response.text();
            } catch {
              responseData = null;
            }
          } else {
            responseData = null;
          }
        }
      } else if (typeof response.text === "function") {
        try {
          responseData = await response.text();
        } catch {
          responseData = null;
        }
      } else if (typeof response.json === "function") {
        try {
          responseData = await response.json();
        } catch {
          responseData = null;
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new ApiAuthError(
          response.statusText || "Authentication required",
          response.status,
          responseData,
        );
      }

      if (!response.ok) {
        throw new ApiHttpError(
          response.statusText || `HTTP Error ${response.status}`,
          response.status,
          responseData,
        );
      }

      return responseData as T;
    } catch (error) {
      if (error instanceof ApiAuthError || error instanceof ApiHttpError) {
        throw error;
      }
      throw new ApiNetworkError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
