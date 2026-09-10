import { parse, stringify } from "yaml";
export const parseYaml = (text: string): unknown => parse(text);
export const stringifyYaml = (value: unknown): string => stringify(value);
export const requestUrl = async (): Promise<never> => { throw new Error("No HTTP mock configured"); };
export class FileSystemAdapter {
  getBasePath(): string {
    return "";
  }
}

export class Modal {}

export class Notice {
  constructor(readonly message: string) {}
}

export class PluginSettingTab {}

export class Setting {}

export class TFile {
  path = "";
  basename = "";
  extension = "md";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder {
  path = "";
}

export type App = unknown;
export type ButtonComponent = unknown;
