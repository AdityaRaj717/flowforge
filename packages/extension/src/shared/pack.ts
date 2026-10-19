// The Flow "selector pack": everything the adapter knows about Flow's page, as data.
// When Flow ships a UI change, a new pack can be pushed (fetched JSON, never code) or the user
// can teach a control by clicking it. Nothing about Flow's DOM is hard-coded in the adapter.

export type Strategy =
  | { css: string; text?: string }
  | { role: string; name?: string } // name is a case-insensitive regex source
  | { ariaLabel: string } // regex source
  | { text: string; tag?: string } // regex source over innerText, tag defaults to button-ish
  | { placeholder: string };

export interface TargetSpec {
  label: string;
  /** Tried in order; the first visible match wins. User-taught strategies are prepended. */
  strategies: Strategy[];
  optional?: boolean;
}

export type TargetId =
  | 'composer'
  | 'submit'
  | 'stop'
  | 'newSession'
  | 'newProject'
  | 'attach'
  | 'fileInput'
  | 'approve'
  | 'settings'
  | 'modelMenu'
  | 'aspectMenu'
  | 'countMenu'
  | 'modeMenu'
  | 'uploadMedia'
  | 'dismissDialog';

export interface PageSignal {
  /** Regex sources matched against text that appeared after submit (or the whole page for `page` scope). */
  patterns: string[];
  scope: 'new' | 'page';
}

export interface SelectorPack {
  version: string;
  /** Hosts this pack applies to. */
  hosts: string[];
  targets: Record<TargetId, TargetSpec>;
  /** Where generated media live; used to tell outputs apart from UI images. */
  media: {
    imageUrlHints: string[]; // substrings; any match qualifies a large <img>
    minImageSide: number;
    excludeWithin: string[]; // css of containers whose media are not outputs (composer chips, avatars)
    /** Hosts whose images are never outputs (icons, zero-state art). */
    denyHosts: string[];
    /** Optional: a newest-first grid item. New outputs must sit above every tile that existed before submit. */
    newestFirstItem?: string;
  };
  /** Flow's "Agent settings" panel (composer › Settings), where per-kind defaults live. */
  agentSettings: {
    heading: string; // regex source for the panel heading
    group: string; // aria-label template: {Kind} {what}; what = aspect ratio | output count | model
    countText: string; // option text template, {n}
    save: string; // regex source for the save button text
    back: string; // aria-label regex for closing without saving
  };
  signals: {
    captcha: PageSignal;
    unusualActivity: PageSignal;
    signedOut: PageSignal;
    policy: PageSignal;
    credits: PageSignal;
    rateLimit: PageSignal;
    queueFull: PageSignal;
    failed: PageSignal;
    consent: PageSignal;
    busy: PageSignal;
  };
  /** Option words the agent understands when settings are passed as an instruction. */
  instruction: {
    template: string; // {count} {kind} {aspect} {model} {duration} {prompt}
  };
  /** Text matched when choosing an option inside an opened menu. */
  optionText: {
    aspect: Record<string, string[]>;
    count: Record<string, string[]>;
  };
}

export const DEFAULT_PACK: SelectorPack = {
  version: '2026.10.19-1',
  hosts: ['https://flow.google.com/', 'https://labs.google/fx/'],
  targets: {
    composer: {
      label: 'Prompt box',
      strategies: [
        { css: '[contenteditable="true"][role="textbox"]' },
        { css: 'div[contenteditable="true"]' },
        { css: 'textarea[placeholder]' },
        { role: 'textbox' },
        { css: 'textarea' },
      ],
    },
    submit: {
      label: 'Generate / send button',
      strategies: [
        { ariaLabel: '^start generation$' },
        { ariaLabel: '^(generate|create|send|submit|démarrer la génération|générer|envoyer)' },
        { css: 'button[type="submit"]' },
        { text: '^(arrow_forward|send|generate|create)$' },
      ],
    },
    stop: {
      label: 'Stop button (shown while working)',
      optional: true,
      strategies: [{ ariaLabel: '^(stop|cancel|arrêter)( generation| génération)?$' }, { text: '^(stop|stop_circle)$' }],
    },
    newSession: {
      label: 'New session / clear chat',
      optional: true,
      strategies: [{ ariaLabel: '^start new session$' }, { ariaLabel: '^(new session|new chat|nouvelle session)' }],
    },
    newProject: {
      label: 'New project',
      optional: true,
      strategies: [{ ariaLabel: '(new project|nouveau projet)' }, { text: '^(new project|nouveau projet)$' }],
    },
    attach: {
      label: 'Add image / attach button',
      optional: true,
      strategies: [
        { ariaLabel: '^add ingredients to the prompt box$' },
        { ariaLabel: '(add (an )?image|upload|attach|add media|add reference|ajouter)' },
        { text: '^(add_photo_alternate|attach_file|add|image)$' },
      ],
    },
    fileInput: {
      label: 'File input',
      optional: true,
      strategies: [{ css: 'input[type="file"][accept*="image"]' }, { css: 'input[type="file"]' }],
    },
    approve: {
      label: 'Approve plan button',
      optional: true,
      // Only buttons that appear after submitting and sit outside the prompt box are considered,
      // so "Generate" here is the agent's confirmation, never the composer's submit button.
      // Live Flow (2026-10-19) shows Approve / Always approve / Reject as role="radio" rows before a
      // credit-costing video. Exact match only: "Always approve" would change the user's Flow setting.
      strategies: [
        { role: 'radio', name: '^(approve|approuver)$' },
        { text: '^(approve|confirm|proceed|generate|continue|yes|go ahead|confirmer|valider|générer)\\b', tag: 'button' },
      ],
    },
    settings: {
      label: 'Generation settings',
      optional: true,
      // Two buttons are labelled "Settings" in Flow; the composer one shows the "tune" icon.
      strategies: [{ css: 'button[aria-label="Settings"]', text: '^tune$' }, { ariaLabel: '(settings|tune|paramètres|options)' }, { text: '^(tune|settings)$' }],
    },
    modelMenu: { label: 'Model picker', optional: true, strategies: [{ ariaLabel: '(model|modèle)' }] },
    aspectMenu: { label: 'Aspect ratio picker', optional: true, strategies: [{ ariaLabel: '(aspect|ratio|format)' }] },
    countMenu: { label: 'Outputs per prompt picker', optional: true, strategies: [{ ariaLabel: '(outputs|number of|count|nombre)' }] },
    modeMenu: { label: 'Mode picker (image / video)', optional: true, strategies: [{ ariaLabel: '(mode|type)' }] },
    uploadMedia: {
      label: '"Upload media" in the ingredients picker',
      optional: true,
      strategies: [{ css: '.cdk-overlay-pane button', text: 'upload media' }, { text: '^(upload\\s*)?upload media$' }],
    },
    dismissDialog: {
      label: "What's-new dialog button",
      optional: true,
      strategies: [{ css: '.cdk-overlay-pane button, [role="dialog"] button', text: '^(get started|got it|dismiss)$' }],
    },
  },
  media: {
    imageUrlHints: ['/asb/', 'flow-content.google', 'googleusercontent.com', 'storage.googleapis.com', 'blob:', 'data:image'],
    minImageSide: 256,
    excludeWithin: ['[contenteditable="true"]', 'header', 'nav', '[role="dialog"] [aria-label*="avatar" i]', '#flowforge-overlay', '.cdk-overlay-pane'],
    denyHosts: ['gstatic.com', 'lh3.google.com/u/', 'googleusercontent.com/a/'],
    // Live Flow (2026-10-19): the grid is virtualised, so older tiles re-enter the DOM as new rows land
    // and look "new"; they always enter below the tiles that were already there.
    newestFirstItem: 'flow-grid-tile-container',
  },
  agentSettings: {
    heading: '^agent settings$',
    group: '{Kind} generation default {what}',
    countText: 'x{n}',
    save: '^save$',
    back: '^(back|close)$',
  },
  signals: {
    captcha: { scope: 'page', patterns: ["verify (that )?you('| a)re (a )?human", 'recaptcha challenge', 'confirm you.re not a robot', 'vérifiez que vous'] },
    unusualActivity: { scope: 'page', patterns: ['unusual activity', 'activité inhabituelle', 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'suspicious activity'] },
    signedOut: { scope: 'page', patterns: ['^sign in$', 'sign in to continue', 'connectez-vous pour continuer'] },
    policy: {
      scope: 'new',
      patterns: [
        'violat(e|es|ed|ion)',
        'policy', 'guidelines', 'not able to (help|generate|create)', "can.t (help|generate|create) (with )?(that|this)",
        'unable to generate', 'safety', 'politique', 'enfreint',
      ],
    },
    credits: { scope: 'new', patterns: ['(not enough|out of|insufficient|no) credits', 'credit limit', 'daily limit', 'upgrade (your plan|to)', 'crédits insuffisants'] },
    rateLimit: { scope: 'new', patterns: ['too many requests', 'rate limit', 'try again (later|in a few)', 'slow down', 'réessayez plus tard'] },
    queueFull: { scope: 'new', patterns: ['queue is full', 'too many (generations|jobs) in progress', 'maximum (number of )?(concurrent|simultaneous)'] },
    failed: { scope: 'new', patterns: ['generation failed', 'something went wrong', "couldn.t (generate|create)", 'une erreur', 'failed to generate'] },
    consent: { scope: 'page', patterns: ['rights to use this (image|video|media|content)', 'make sure you have the necessary rights'] },
    busy: { scope: 'page', patterns: ['generating', 'thinking', 'working on it', '\\d{1,3}%', 'génération en cours'] },
  },
  instruction: {
    template: 'Generate {count} {kind} {aspectPhrase}{modelPhrase}{durationPhrase}. Use this prompt exactly:\n\n{prompt}',
  },
  optionText: {
    aspect: {
      '16:9': ['16:9', 'landscape', 'paysage'],
      '9:16': ['9:16', 'portrait'],
      '1:1': ['1:1', 'square', 'carré'],
      '4:3': ['4:3'],
      '3:4': ['3:4'],
    },
    count: { '1': ['x1', '1'], '2': ['x2', '2'], '3': ['x3', '3'], '4': ['x4', '4'] },
  },
};

export function isPack(x: unknown): x is SelectorPack {
  const p = x as SelectorPack;
  return !!p && typeof p.version === 'string' && !!p.targets?.composer && !!p.targets?.submit && !!p.signals && !!p.media;
}
