# TikTok Global Policy Source Coverage

Retrieved: 2026-08-14

Policy marker: `2025H2update` / “2025 August”

Released: 2025-08-14

Effective: 2025-09-13

All URLs are official TikTok-owned primary sources. Checksums and normalized byte counts are recorded in `policies/sources/tiktok-global-2025-h2/manifest.json`.

| Source | Rules | Categories mapped | Outcome support | Open questions |
|---|---:|---|---|---|
| [Overview](https://www.tiktok.com/safety/en/policies-and-engagement/overview?cgversion=2025H2update) | 0 | Metadata baseline | Defines removal, age restriction, FYF exclusion | Summary only; detailed rules come from topic pages |
| [Youth Safety and Well-Being](https://www.tiktok.com/safety/en/policies-and-engagement/youth-safety?cgversion=2025H2update) | 1 | minor safety | FYF | Country-specific minimum ages remain outside this global record |
| [Safety and Civility](https://www.tiktok.com/safety/en/policies-and-engagement/safety-civility?cgversion=2025H2update) | 14 | violence, hate speech, harassment, bullying, minor safety, sexual content, illegal activity | Postability, FYF, age restriction | Regional religious-disparagement treatment is not normalized globally |
| [Mental and Behavioral Health](https://www.tiktok.com/safety/en/policies-and-engagement/mental-behavioral-health?cgversion=2025H2update) | 7 | suicide, self-harm, dangerous activities, disordered eating | Postability, FYF, age restriction | Granular body-image examples remain represented by the source rather than duplicated |
| [Sensitive and Mature Themes](https://www.tiktok.com/safety/en/policies-and-engagement/sensitive-mature-themes?cgversion=2025H2update) | 7 | sexual content, nudity, graphic and shocking content, animal abuse | Postability, FYF, age restriction | Some sexual-content treatments vary by region |
| [Integrity and Authenticity](https://www.tiktok.com/safety/en/policies-and-engagement/integrity-authenticity?cgversion=2025H2update) | 9 | misinformation, civic integrity, IP, unoriginal content, spam | Postability, FYF | Detailed AIGC labeling requirements remain a follow-up mapping |
| [Regulated Goods, Services, and Commercial Activities](https://www.tiktok.com/safety/en/policies-and-engagement/regulated-commercial-activities?cgversion=2025H2update) | 5 | regulated goods, drugs, weapons, fraud, spam | Postability, FYF, age restriction | Weapon and some business treatments vary by region |
| [Privacy and Security](https://www.tiktok.com/safety/en/policies-and-engagement/privacy-security?cgversion=2025H2update) | 3 | privacy, personal information, illegal activity | Postability | Moderate-risk information requires contextual judgment |
| [For You feed Eligibility Standards](https://www.tiktok.com/safety/en/policies-and-engagement/fyf-standards?cgversion=2025H2update) | 1 | broad-audience recommendation baseline | FYF | Repetitive recommendation interruption is not a per-video verdict |
| [Accounts and Features](https://www.tiktok.com/safety/en/policies-and-engagement/accounts-features?cgversion=2025H2update) | 6 | unoriginal, shocking, profanity, spam, monetization | FYF, feature restriction, conditional monetization | Feature-specific monetization policies require separate versioned ingestion |
| [Enforcement](https://www.tiktok.com/safety/en/policies-and-engagement/enforcement?cgversion=2025H2update) | 1 | public-interest exception | Conditional postability and possible safety treatments | Warning/FYF treatment is discretionary, so values remain unknown |

## Current gaps

The source layer captures every required top-level page and the directly linked youth-safety page. Production records provide a reviewed baseline for every major adjudicable topic, but do not duplicate every official example or regional variant. Additional atomic detail may be added later without changing the versioned contract.

Detailed monetization policy requires separate capture and dating of the official Creator Rewards Program, Creator Code of Conduct, LIVE Monetization Guidelines, branded-content rules, and other program-specific pages linked by Accounts and Features. They were not mixed into the 2025-H2 Community Guidelines baseline because their independent version/effective dates were not established.
