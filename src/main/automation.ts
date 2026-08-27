/**
 * @fileoverview Optional localhost automation metadata endpoint.
 *
 * The endpoint exposes the current Browserbase CDP connection URL for local
 * browser automation libraries. It is disabled by default because the CDP URL
 * contains Browserbase credentials.
 */

import * as fs from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import * as path from "path";
import { TabInfo } from "../shared/types";

const AUTOMATION_HOST = "127.0.0.1";

export interface AutomationSessionInfo {
  sessionId: string;
  status: string;
  connectUrl: string;
  debugUrl: string;
  currentUrl: string;
  tabs: TabInfo[];
}

type SessionInfoProvider = () => AutomationSessionInfo | null;

export function isAutomationServerEnabled(): boolean {
  const value = process.env.BROWSERBASE_AUTOMATION_SERVER;
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getAutomationServerPort(): number {
  const value = process.env.BROWSERBASE_AUTOMATION_PORT;
  if (!value) {
    return 0;
  }

  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port >= 0 && port <= 65535 ? port : 0;
}

export class AutomationServer {
  private server: Server | null = null;

  constructor(
    private readonly getSessionInfo: SessionInfoProvider,
    private readonly userDataPath: string
  ) {}

  async start(port: number = 0): Promise<number> {
    if (this.server) {
      const address = this.server.address() as AddressInfo;
      return address.port;
    }

    this.server = createServer((request, response) => {
      this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, AUTOMATION_HOST, () => resolve());
    });

    const address = this.server.address() as AddressInfo;
    this.writeDescriptor(address.port);
    return address.port;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    this.removeDescriptor();
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      this.sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const requestUrl = new URL(request.url || "/", `http://${AUTOMATION_HOST}`);

    if (requestUrl.pathname === "/health") {
      this.sendJson(response, 200, { ok: true });
      return;
    }

    const sessionInfo = this.getSessionInfo();
    if (!sessionInfo) {
      this.sendJson(response, 503, { error: "No Browserbase session is available yet" });
      return;
    }

    if (requestUrl.pathname === "/session") {
      this.sendJson(response, 200, sessionInfo);
      return;
    }

    if (requestUrl.pathname === "/json/version") {
      this.sendJson(response, 200, {
        Browser: "Desktop Browserbase",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: sessionInfo.connectUrl,
      });
      return;
    }

    if (requestUrl.pathname === "/json/list") {
      this.sendJson(
        response,
        200,
        sessionInfo.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          type: "page",
          url: tab.url,
          webSocketDebuggerUrl: sessionInfo.connectUrl,
        }))
      );
      return;
    }

    this.sendJson(response, 404, { error: "Not found" });
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body, null, 2));
  }

  private writeDescriptor(port: number): void {
    const baseUrl = `http://${AUTOMATION_HOST}:${port}`;
    const descriptor = {
      enabled: true,
      host: AUTOMATION_HOST,
      port,
      baseUrl,
      sessionEndpoint: `${baseUrl}/session`,
      jsonVersionEndpoint: `${baseUrl}/json/version`,
      jsonListEndpoint: `${baseUrl}/json/list`,
    };

    fs.mkdirSync(this.userDataPath, { recursive: true });
    fs.writeFileSync(this.getDescriptorPath(), JSON.stringify(descriptor, null, 2));
  }

  private removeDescriptor(): void {
    try {
      fs.rmSync(this.getDescriptorPath(), { force: true });
    } catch (error) {
      console.warn("Failed to remove automation descriptor:", error);
    }
  }

  private getDescriptorPath(): string {
    return path.join(this.userDataPath, "automation.json");
  }
}
