// Is this step something the agent may do, something the user must approve,
// or something only the user may do (pay, type a password, solve a CAPTCHA)?
// Checked in the page for every step, whatever the agent asked for.

import { describe, isSecretField, nameOf, roleOf, SECRET_HINT } from './dom.ts';

export interface RiskConfig {
  /** Hosts where every action is the user's (payment gateways, banks). */
  handoffHosts: string[];
  /** Button/link names that mean money moves or an account goes. */
  handoffWords: string;
  /** Button/link names that publish, send or delete: the user says yes first. */
  approveWords: string;
}

export const DEFAULT_RISK: RiskConfig = {
  handoffHosts: [
    'razorpay.com', 'api.razorpay.com', 'checkout.stripe.com', 'js.stripe.com', 'paypal.com', 'payu.in', 'secure.payu.in',
    'ccavenue.com', 'billdesk.com', 'paytm.com', 'securegw.paytm.in', 'phonepe.com', 'mercury.phonepe.com', 'cashfree.com',
    'juspay.in', 'checkout.com', 'adyen.com', 'braintreegateway.com', 'klarna.com', 'pay.google.com', 'payments.google.com',
    'onlinesbi.sbi', 'netbanking.hdfcbank.com', 'hdfcbank.com', 'icicibank.com', 'axisbank.com', 'kotak.com', 'pnbindia.in',
    'bankofbaroda.in', 'yesbank.in', 'idfcfirstbank.com', 'indusind.com', 'recaptcha.net', 'hcaptcha.com',
    'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com',
  ],
  handoffWords: String.raw`\b(pay( now| securely)?|buy( now)?|place (your )?order|complete (purchase|order|payment)|confirm (payment|purchase|order|and pay)|proceed to pay(ment)?|make payment|purchase|checkout|transfer( money| funds)?|send money|withdraw|donate|subscribe( now)?|start (free )?trial|upgrade( now)?|delete (my |your )?account|close (my |your )?account|deactivate account|i'?m not a robot|verify you are human)\b`,
  approveWords: String.raw`\b(send|publish|post|tweet|reply( all)?|comment|delete|remove|discard|archive|merge|deploy|submit (application|review)|apply( now)?|accept|agree|sign up|register|unsubscribe|book( now)?|reserve|confirm|share|invite|cancel (order|subscription|booking))\b`,
};

export interface Risk { level: 'none' | 'approve' | 'handoff'; reason?: string; what?: string }

function hostMatches(host: string, list: string[]) {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

/** Risk of the page as a whole (a payment gateway, a bank, a CAPTCHA frame). */
export function pageRisk(cfg: RiskConfig): Risk {
  if (hostMatches(location.hostname, cfg.handoffHosts)) return { level: 'handoff', reason: `${location.hostname} is a payment, bank or CAPTCHA page` };
  return { level: 'none' };
}

export function stepRisk(kind: string, el: Element | undefined, cfg: RiskConfig): Risk {
  const passive = kind === 'scroll' || kind === 'wait' || kind === 'hover' || kind === 'move' || kind === 'focus';
  const page = pageRisk(cfg);
  if (page.level !== 'none' && !passive) return { ...page, what: el ? describe(el) : undefined };
  if (!el || passive) return { level: 'none' };
  const what = describe(el);

  if (kind === 'type' || kind === 'fill' || kind === 'clear' || kind === 'press') {
    if (isSecretField(el)) return { level: 'handoff', reason: 'this field takes a password, card number or one-time code', what };
  }
  if (kind === 'upload') return { level: 'none', what };

  if (kind === 'click' || kind === 'check' || kind === 'select' || kind === 'press' || kind === 'drag') {
    const role = roleOf(el) || el.localName;
    const target = el.closest('button, a, [role=button], [role=link], input[type=submit], input[type=button], input[type=image], summary, label') ?? el;
    const name = (nameOf(target) || nameOf(el)).toLowerCase().slice(0, 120);
    const clickable = /button|link|clickable|menuitem|option|checkbox|tab/.test(role) || target !== el || el.localName === 'input';
    if (clickable && name) {
      if (new RegExp(cfg.handoffWords, 'i').test(name)) return { level: 'handoff', reason: `"${name}" moves money, buys something or removes an account`, what };
      // A submit inside a form holding card/OTP fields with something in them.
      const form = (target as HTMLButtonElement).form ?? target.closest('form');
      if (form && isSubmit(target) && formHasPayment(form)) return { level: 'handoff', reason: 'this form holds card or payment details', what };
      if (kind === 'click' && new RegExp(cfg.approveWords, 'i').test(name)) return { level: 'approve', reason: `"${name}" sends, publishes or deletes something`, what };
    }
  }
  return { level: 'none', what };
}

function isSubmit(el: Element) {
  const t = (el as HTMLInputElement).type;
  return (el.localName === 'button' && (!t || t === 'submit')) || (el.localName === 'input' && (t === 'submit' || t === 'image'));
}

function formHasPayment(form: Element) {
  for (const f of Array.from(form.querySelectorAll('input'))) {
    const ac = (f.getAttribute('autocomplete') ?? '').toLowerCase();
    if (ac.startsWith('cc-')) return true;
    const hint = [f.name, f.id, f.getAttribute('placeholder')].join(' ').toLowerCase();
    if (/card|cvv|cvc|expiry|upi/.test(hint) && SECRET_HINT.test(hint)) return true;
  }
  return false;
}
