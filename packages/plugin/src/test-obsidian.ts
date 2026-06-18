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

export type App = unknown;
export type ButtonComponent = unknown;
