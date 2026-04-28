import { describe, it, expect } from 'vitest'
import type { CertSummary } from '../../src/probe.d.mts'
import {
  buildFreshTofuBanner,
  buildMismatchBanner,
  buildConfigMissingBanner,
} from '../../src/channel-setup'

const SAMPLE_INTERNAL: CertSummary = {
  subject: 'tc.example.com',
  issuerCN: 'Acme Internal CA',
  issuerOrg: 'Acme, Inc.',
  validFrom: 'Jan  1 00:00:00 2026 GMT',
  validTo: 'Jan  1 00:00:00 2027 GMT',
  fingerprint: 'AB:CD:EF:12:34:56:78:90:12:34:56:78:90:12:34:56:78:90:12:34:56:78:90:12:34:56:78:90:12:34:56:78',
  san: 'DNS:tc.example.com',
  selfSigned: false,
}

const SAMPLE_SELF_SIGNED: CertSummary = {
  ...SAMPLE_INTERNAL,
  issuerCN: 'tc.example.com',
  issuerOrg: null,
  selfSigned: true,
}

describe('buildFreshTofuBanner', () => {
  it('includes subject, issuer, validity, fingerprint', () => {
    const b = buildFreshTofuBanner(SAMPLE_INTERNAL, 'ru')
    expect(b.body).toContain('tc.example.com')
    expect(b.body).toContain('Acme Internal CA')
    expect(b.body).toContain('Acme, Inc.')
    expect(b.body).toContain('Jan')
    expect(b.body).toContain('AB:CD:EF')
    expect(b.body).toContain('SHA-256')
  })

  it('includes selfSigned hint when cert.selfSigned is true', () => {
    const b = buildFreshTofuBanner(SAMPLE_SELF_SIGNED, 'ru')
    expect(b.body).toMatch(/самоподписан/)
  })

  it('omits selfSigned hint for internal CA', () => {
    const b = buildFreshTofuBanner(SAMPLE_INTERNAL, 'ru')
    expect(b.body).not.toMatch(/самоподписан/)
  })

  it('prompts for out-of-band verification', () => {
    const b = buildFreshTofuBanner(SAMPLE_INTERNAL, 'ru')
    expect(b.body).toMatch(/Сверьте отпечаток/)
  })

  it('renders English copy when locale is en', () => {
    const b = buildFreshTofuBanner(SAMPLE_SELF_SIGNED, 'en')
    expect(b.body).toMatch(/self-signed/)
    expect(b.body).toMatch(/Verify the fingerprint/)
    expect(b.title).not.toMatch(/Подтверждение/)
  })
})

describe('buildMismatchBanner', () => {
  const stored: CertSummary = {
    ...SAMPLE_INTERNAL,
    fingerprint: '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF',
  }
  const current: CertSummary = {
    ...SAMPLE_INTERNAL,
    issuerCN: 'Different CA',
    fingerprint: 'FF:EE:DD:CC:BB:AA:00:99:88:77:66:55:44:33:22:11:FF:EE:DD:CC:BB:AA:00:99:88:77:66:55:44:33:22:11',
  }

  it('labels stored side as "trust anchor" not as a leaf cert', () => {
    const b = buildMismatchBanner(stored, current, '/tmp/ca.pem', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ru')
    expect(b.body).toMatch(/trust anchor/)
    expect(b.body).not.toMatch(/сертификат сервера изменился/)
  })

  it('shows both stored and current fingerprints', () => {
    const b = buildMismatchBanner(stored, current, '/tmp/ca.pem', 'err', 'ru')
    expect(b.body).toContain('11:22:33')
    expect(b.body).toContain('FF:EE:DD')
  })

  it('includes the caPath and tls error', () => {
    const b = buildMismatchBanner(stored, current, '/tmp/ca.pem', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ru')
    expect(b.body).toContain('/tmp/ca.pem')
    expect(b.body).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  })

  it('renders English copy when locale is en', () => {
    const b = buildMismatchBanner(stored, current, '/tmp/ca.pem', 'err', 'en')
    expect(b.body).toMatch(/no longer validates|trust anchor/)
    expect(b.body).not.toMatch(/больше не валидирует/)
  })
})

describe('buildConfigMissingBanner', () => {
  it('shows path, reason, and server cert info', () => {
    const b = buildConfigMissingBanner(
      '/tmp/ca.pem',
      'ENOENT: no such file or directory',
      SAMPLE_INTERNAL,
      'ru',
    )
    expect(b.body).toContain('/tmp/ca.pem')
    expect(b.body).toMatch(/ENOENT|не найден|не читается/)
    expect(b.body).toContain('tc.example.com')
  })

  it('instructs user to verify fingerprint with admin before re-TOFU', () => {
    const b = buildConfigMissingBanner('/x', 'err', SAMPLE_INTERNAL, 'ru')
    expect(b.body).toMatch(/Сверьте отпечаток/)
  })

  it('renders English copy when locale is en', () => {
    const b = buildConfigMissingBanner('/tmp/ca.pem', 'ENOENT', SAMPLE_INTERNAL, 'en')
    expect(b.body).toMatch(/Verify the fingerprint/)
    expect(b.body).not.toMatch(/Сверьте/)
  })
})
