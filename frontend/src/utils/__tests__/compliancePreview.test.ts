import { describe, it, expect } from 'vitest';
import { buildReportPreviewHtml, buildPdfPreviewHtml, buildCsvPreviewHtml } from '../compliancePreview';
import { escapeHtml } from '../escapeHtml';
import type { AuditEntry } from '../auditVerification';

const PAYLOAD = '<img src=x onerror="alert(1)">';

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: '1',
    sourceEventId: 'evt-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    ledger: '100',
    contractId: 'CVAULT',
    user: 'GUSERADDRESS123456',
    action: 'proposal_created',
    details: {},
    transactionHash: 'tx-1',
    topicFingerprint: '',
    payloadDigest: '',
    ...overrides,
  } as AuditEntry;
}

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders null and undefined as empty text', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('compliance preview markup', () => {
  const hostile = entry({ action: PAYLOAD, user: PAYLOAD + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });

  it('escapes entry action and user in the report preview', () => {
    const html = buildReportPreviewHtml({
      type: 'SOC2',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      sections: ['Security'],
      entries: [hostile],
    });

    expect(html).not.toContain('<img');
    expect(html).toContain(escapeHtml(PAYLOAD));
  });

  it('escapes section names and report type in the report preview', () => {
    const html = buildReportPreviewHtml({
      type: PAYLOAD,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      sections: [PAYLOAD],
      entries: [],
    });

    expect(html).not.toContain('<img');
  });

  const exportData = {
    reportType: PAYLOAD,
    vaultAddress: PAYLOAD,
    reportPeriod: { start: '2026-01-01', end: '2026-01-31' },
    complianceScore: 90,
    sections: [PAYLOAD],
    entries: [hostile],
  };

  it('escapes every interpolated value in the PDF preview', () => {
    const html = buildPdfPreviewHtml(exportData);

    expect(html).not.toContain('<img');
    expect(html).toContain(escapeHtml(PAYLOAD));
  });

  it('escapes every interpolated value in the CSV preview', () => {
    const html = buildCsvPreviewHtml(exportData);

    expect(html).not.toContain('<img');
    expect(html).toContain(escapeHtml(PAYLOAD));
  });

  it('still renders the section rows and score for benign input', () => {
    const html = buildPdfPreviewHtml({ ...exportData, reportType: 'SOC2', vaultAddress: 'CVAULT', sections: ['Security'], entries: [] });

    expect(html).toContain('Score: 90%');
    expect(html).toContain('<td style="padding:6px 10px;border-bottom:1px solid #333">Security</td>');
  });
});
