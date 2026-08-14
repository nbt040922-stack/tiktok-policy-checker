# TikTok Policy Mapping Review

This is the human-review ledger for `tiktok-global-2025-h2`. Internal categories are retrieval labels, not official TikTok section names.

| Official section / treatment | Internal category | Postability | FYF | Monetization | Context or ambiguity |
|---|---|---|---|---|---|
| Violent and Criminal Behavior / Not Allowed | violence | PROHIBIT | UNKNOWN | UNKNOWN | Documentary, educational, criticism, fiction, and art are separate allowed context |
| Hate Speech / Not Allowed | hate_speech | PROHIBIT | UNKNOWN | UNKNOWN | Protected-attribute attack required |
| Hate Speech / FYF Ineligible & Age-Restricted | hate_speech | ALLOW | PROHIBIT | UNKNOWN | Age restriction preserved separately |
| Harassment / Not Allowed | harassment | PROHIBIT | UNKNOWN | UNKNOWN | Severe targeted behavior |
| Harassment / FYF Ineligible & Age-Restricted | bullying | ALLOW | PROHIBIT | UNKNOWN | Applies to hostile/profane targeting of private figures |
| Youth Abuse / Not Allowed | minor_safety | PROHIBIT | UNKNOWN | UNKNOWN | No public-interest exception for extreme youth-abuse imagery |
| Suicide and Self-Harm / Not Allowed | suicide | PROHIBIT | UNKNOWN | UNKNOWN | Promotion, instruction, plans, or showing acts |
| Suicide and Self-Harm / FYF Ineligible Age-Restricted | self_harm | ALLOW | PROHIBIT | UNKNOWN | Detailed descriptions and specified contextual depictions |
| Suicide and Self-Harm / Allowed | self_harm | ALLOW | UNKNOWN | UNKNOWN | Recovery/prevention only without method details |
| Dangerous Activity / Not Allowed | dangerous_activities | PROHIBIT | UNKNOWN | UNKNOWN | Significant-harm threshold |
| Dangerous Activity / FYF Ineligible Age-Restricted | dangerous_activities | ALLOW | PROHIBIT | UNKNOWN | Moderate-harm threshold |
| Body Exposure / Not Allowed | sexual_content, nudity | PROHIBIT | UNKNOWN | UNKNOWN | Separate atomic records for sexual acts and nudity |
| Body Exposure / FYF Ineligible & Age-Restricted | sexual_content | ALLOW | PROHIBIT | UNKNOWN | Some listed treatment is region-dependent |
| Shocking and Graphic / Not Allowed | graphic_content | PROHIBIT | UNKNOWN | UNKNOWN | Severe real-world imagery |
| Shocking and Graphic / public-interest restriction | shocking_content | ALLOW | PROHIBIT | UNKNOWN | Age-restricted; most graphic imagery remains prohibited |
| Misinformation / Not Allowed | misinformation | PROHIBIT | UNKNOWN | UNKNOWN | Significant-harm threshold |
| Misinformation / FYF Ineligible | misinformation | ALLOW | PROHIBIT | UNKNOWN | Moderate harm and specified misleading context |
| Civic Integrity / Not Allowed | civic_integrity | PROHIBIT | UNKNOWN | UNKNOWN | Voting/process/result misinformation and interference |
| Unoriginal and IP / Not Allowed | intellectual_property | PROHIBIT | UNKNOWN | UNKNOWN | Rights violation |
| Unoriginal and IP / FYF Ineligible | unoriginal_content | ALLOW | PROHIBIT | UNKNOWN | Reuse without creative edits; no originality detector added |
| Regulated Goods / Not Allowed | regulated_goods | PROHIBIT | UNKNOWN | UNKNOWN | Registered-business exceptions vary by product and region |
| Cannabis/tobacco treatment | drugs | ALLOW | PROHIBIT | UNKNOWN | Explicitly age-restricted |
| Firearm/explosive treatment | weapons | UNKNOWN | UNKNOWN | UNKNOWN | Source says “in some regions”; no global inference |
| Frauds and Scams / Not Allowed | fraud | PROHIBIT | UNKNOWN | UNKNOWN | Promotion, facilitation, and instruction |
| Personal Information / Not Allowed | privacy, personal_information | PROHIBIT | UNKNOWN | UNKNOWN | Moderate-risk removal depends on additional context |
| Public Interest Exceptions | violence (cross-cutting) | ALLOW | UNKNOWN | UNKNOWN | TikTok may still apply FYF exclusion, warning, or label |
| FYF broad-audience standard | shocking_content (cross-cutting) | ALLOW | PROHIBIT | UNKNOWN | Ineligibility does not itself mean removal |
| Accounts and Features / Monetization | regulated_goods | UNKNOWN | UNKNOWN | RESTRICT | Violation may cause temporary restriction; repeated violations may permanently remove access |
| FYF-to-monetization relationship | unoriginal_content | UNKNOWN | PROHIBIT | UNKNOWN | TikTok says FYF-ineligible content “may” also be restricted from monetization |

## Review decisions

- `RESTRICT` for postability is used only for an explicitly described posting/account restriction, not as a proxy for age restriction.
- `platformTreatment.ageRestricted` carries the adult-only distinction.
- `platformTreatment.warningScreen` stays `null` where TikTok says a warning may be applied case by case.
- `UNKNOWN` means the source does not establish that outcome; it is not an allowed verdict.
- Monetization is deliberately mostly `UNKNOWN` because Community Guidelines and FYF treatment do not automatically determine program eligibility.

## Ambiguities requiring follow-up

1. Region-specific firearm, gambling, alcohol, religious-disparagement, and sexual-content treatments need locale-specific policy sets.
2. Public-interest exception review is discretionary; warning, label, and FYF treatment cannot be predetermined from text alone.
3. “May also be restricted from monetization” does not define an automatic mapping.
4. Feature-specific creator monetization pages need independent source dates before their rules can join this versioned set.
