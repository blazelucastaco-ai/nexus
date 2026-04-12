// Protocol types shared conceptually between the bridge (Node) and extension (JS)

export interface BridgeCommand {
  id: string;
  type: 'command';
  action: BridgeAction;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  type: 'response';
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgePing {
  type: 'ping';
}

export interface BridgePong {
  type: 'pong';
}

export type BridgeAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'clear'
  | 'extract'
  | 'screenshot'
  | 'evaluate'
  | 'scroll'
  | 'wait_for'
  | 'get_info'
  | 'get_tabs'
  | 'switch_tab'
  | 'new_tab'
  | 'close_tab'
  | 'fill_form'
  | 'back'
  | 'forward'
  | 'reload'
  | 'select';

// ------ Typed param shapes ------

export interface NavigateParams   { url: string }
export interface ClickParams      { selector?: string; text?: string; index?: number }
export interface TypeParams       { selector?: string; text: string; clear?: boolean }
export interface SelectParams     { selector: string; value: string }
export interface ExtractParams    { selector?: string; attribute?: string; all?: boolean }
export interface EvaluateParams   { code: string }
export interface ScrollParams     { x?: number; y?: number; selector?: string }
export interface WaitForParams    { selector: string; timeout?: number }
export interface SwitchTabParams  { tabId: number }
export interface NewTabParams     { url?: string }
export interface CloseTabParams   { tabId?: number }
export interface FillFormParams   { fields: Array<{ selector: string; value: string }> }
