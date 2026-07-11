export function eastmoneyQuoteUrl(code: string): string | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  if (/^(4|8|920)/.test(code)) {
    return `https://quote.eastmoney.com/bj/${code}.html`;
  }

  const market = /^[569]/.test(code) ? "sh" : "sz";
  return `https://quote.eastmoney.com/${market}${code}.html`;
}
