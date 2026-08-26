import { browser } from 'wxt/browser';

export interface TabCaptureApi {
  getMediaStreamId(tabId: number): Promise<string>;
}

export interface OffscreenApi {
  ensureDocument(
    url: string,
    reasons: `${chrome.offscreen.Reason}`[],
    justification: string,
  ): Promise<void>;
  closeDocument(): Promise<void>;
}

export class ChromeTabCaptureApi implements TabCaptureApi {
  async getMediaStreamId(tabId: number): Promise<string> {
    return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
}

export class ChromeOffscreenApi implements OffscreenApi {
  async ensureDocument(
    url: string,
    reasons: `${chrome.offscreen.Reason}`[],
    justification: string,
  ): Promise<void> {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
    await chrome.offscreen.createDocument({ url, reasons, justification });
  }

  async closeDocument(): Promise<void> {
    const has = await chrome.offscreen.hasDocument();
    if (has) await chrome.offscreen.closeDocument();
  }
}

export async function getActiveTab(): Promise<{ id: number; url: string } | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return undefined;
  return { id: tab.id, url: tab.url };
}
