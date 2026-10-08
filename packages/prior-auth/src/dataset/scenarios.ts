/**
 * The 24 synthetic prior-authorization requests, as written.
 *
 * Every clinical note is here in plain text because a FHIR `Attachment`
 * carries its content base64-encoded, and a reviewer looking for real PHI or
 * a procedure code cannot read base64. `author.ts` turns these into the
 * committed bundles; `dataset.test.ts` fails if the two disagree.
 *
 * Six strata per policy, each constructed so that its correct outcome is
 * known (P3-D, "The dataset"):
 *
 * | stratum              | constructed so that                                      | correct              |
 * | -------------------- | -------------------------------------------------------- | -------------------- |
 * | `all-met-structured` | every criterion is evidenced by a code or a measurement  | `automated-approval` |
 * | `all-met-narrative`  | every criterion is evidenced, at least one only in prose | `automated-approval` |
 * | `one-missing`        | one criterion has no evidence in the bundle              | `refer-to-clinician` |
 * | `contradicted`       | the note states a value that fails a threshold           | `refer-to-clinician` |
 * | `ambiguous`          | the evidence for one criterion is hedged or undated      | `refer-to-clinician` |
 * | `administrative`     | the `Coverage` is inactive on the date of service        | `refer-to-clinician` |
 *
 * Every person is invented. Names end in digits (Synthea's convention), so
 * none can be mistaken for a real one, and no case is drawn from memory of a
 * real one (ADR 0003 item 1).
 */

export const STRATA = [
  'all-met-structured',
  'all-met-narrative',
  'one-missing',
  'contradicted',
  'ambiguous',
  'administrative',
] as const;
export type Stratum = (typeof STRATA)[number];

export type LabelStatus = 'met' | 'not-met' | 'insufficient';

export interface ConditionSpec {
  /** Suffix of the resource id. */
  readonly key: string;
  readonly icd10cm: string;
  /** The FY2027 ICD-10-CM descriptor, unchanged (ADR 0008's notice). */
  readonly display: string;
  readonly onset: string;
}

export interface NoteSpec {
  readonly key: string;
  readonly description: string;
  /** Absent for an undated note, which is part of the `ambiguous` stratum. */
  readonly date?: string;
  readonly text: string;
}

export interface ScenarioSpec {
  readonly hcpcs: 'E0601' | 'E0470' | 'K0823' | 'E0260';
  readonly stratum: Stratum;
  readonly patient: {
    readonly given: string;
    readonly family: string;
    readonly gender: 'female' | 'male';
    readonly birthDate: string;
    readonly city: string;
    readonly state: string;
  };
  readonly prescriber: { readonly given: string; readonly family: string };
  readonly plan: 'cbk-ma-standard' | 'cbk-ma-plus';
  readonly priority: 'normal' | 'stat';
  /** `Claim.created`: what the submitter asserts, which the clock never reads. */
  readonly created: string;
  readonly serviceDate: string;
  readonly coverageEnd: string;
  readonly diagnoses: readonly ConditionSpec[];
  readonly notes: readonly NoteSpec[];
  /**
   * The label for each criterion: its status and the keys of the conditions
   * or notes that evidence it. Written with the scenario, before any model
   * has read the bundle.
   */
  readonly labels: Readonly<Record<string, { status: LabelStatus; evidence: readonly string[] }>>;
}

const OSA: ConditionSpec = {
  key: 'osa',
  icd10cm: 'G47.33',
  display: 'Obstructive sleep apnea (adult) (pediatric)',
  onset: '2026-07-02',
};

const COVERED_THROUGH = '2026-12-31';
const LAPSED_ON = '2026-06-30';

const met = (...evidence: string[]) => ({ status: 'met' as const, evidence });
const notMet = (...evidence: string[]) => ({ status: 'not-met' as const, evidence });
const insufficient = (...evidence: string[]) => ({ status: 'insufficient' as const, evidence });

// --- E0601: continuous positive airway pressure device -----------------------

const e0601StudyStrong: NoteSpec = {
  key: 'study',
  description: 'Sleep study report',
  date: '2026-07-01',
  text: [
    'In-lab polysomnography, 2026-07-01.',
    'Total sleep time 6.1 hours. Apnea-hypopnea index (AHI) 31 events per hour.',
    'Lowest oxygen saturation 82 percent.',
    'Impression: obstructive sleep apnea.',
  ].join('\n'),
};

const e0601PrescriberNote: NoteSpec = {
  key: 'visit',
  description: 'Prescriber follow-up note',
  date: '2026-09-10',
  text: [
    'Follow-up for obstructive sleep apnea.',
    'Positional therapy with a positional belt from 2026-07-10 to 2026-08-14, 35 days.',
    'Snoring and daytime sleepiness persisted; Epworth score 15.',
    'Order: CPAP device, auto-titrating, pressure range 6 to 14 cm H2O, heated humidifier.',
    'Order signed electronically by the prescriber on 2026-09-10.',
  ].join('\n'),
};

const e0601: readonly ScenarioSpec[] = [
  {
    hcpcs: 'E0601',
    stratum: 'all-met-structured',
    patient: {
      given: 'Rosa482',
      family: 'Okafor917',
      gender: 'female',
      birthDate: '1957-03-14',
      city: 'Springfield',
      state: 'IL',
    },
    prescriber: { given: 'Tomas88', family: 'Lindqvist204' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-14T09:00:00Z',
    serviceDate: '2026-09-21',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [OSA],
    notes: [e0601StudyStrong, e0601PrescriberNote],
    labels: {
      'e0601-osa-diagnosis': met('osa', 'study'),
      'e0601-ahi-threshold': met('study'),
      'e0601-conservative-trial': met('visit'),
      'e0601-prescriber-order': met('visit'),
    },
  },
  {
    hcpcs: 'E0601',
    stratum: 'all-met-narrative',
    patient: {
      given: 'Delphine51',
      family: 'Marchetti330',
      gender: 'female',
      birthDate: '1953-11-02',
      city: 'Dayton',
      state: 'OH',
    },
    prescriber: { given: 'Imani73', family: 'Castellanos618' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-15T14:20:00Z',
    serviceDate: '2026-09-24',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [
      {
        key: 'obesity',
        icd10cm: 'E66.01',
        display: 'Morbid (severe) obesity due to excess calories',
        onset: '2019-05-20',
      },
    ],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        date: '2026-09-12',
        text: [
          'Her husband says she stops breathing several times a night and she falls asleep at red lights.',
          'The home sleep test she did on the second of August came back with twenty-four breathing',
          'interruptions an hour, which together with the history puts her squarely in obstructive',
          'sleep apnea.',
          'Since the middle of July she has slept on her side with a foam wedge sewn into the back of',
          'her nightshirt, close to five weeks now, and the pauses have not let up.',
          'I am ordering a CPAP machine at a fixed pressure of 9 centimetres of water and have signed',
          'the order today.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0601-osa-diagnosis': met('visit'),
      'e0601-ahi-threshold': met('visit'),
      'e0601-conservative-trial': met('visit'),
      'e0601-prescriber-order': met('visit'),
    },
  },
  {
    hcpcs: 'E0601',
    stratum: 'one-missing',
    patient: {
      given: 'Augustin67',
      family: 'Nakamura255',
      gender: 'male',
      birthDate: '1955-06-29',
      city: 'Bloomington',
      state: 'IN',
    },
    prescriber: { given: 'Tomas88', family: 'Lindqvist204' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-16T08:45:00Z',
    serviceDate: '2026-09-28',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [OSA],
    notes: [
      {
        ...e0601StudyStrong,
        date: '2026-08-04',
        text: e0601StudyStrong.text.replace('2026-07-01', '2026-08-04'),
      },
      {
        key: 'visit',
        description: 'Prescriber follow-up note',
        date: '2026-09-11',
        text: [
          'Follow-up after the sleep study, which showed obstructive sleep apnea.',
          'He wants treatment started before the winter.',
          'Order: CPAP device, fixed pressure 10 cm H2O, full face mask.',
          'Order signed electronically by the prescriber on 2026-09-11.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0601-osa-diagnosis': met('osa', 'study'),
      'e0601-ahi-threshold': met('study'),
      'e0601-conservative-trial': insufficient(),
      'e0601-prescriber-order': met('visit'),
    },
  },
  {
    hcpcs: 'E0601',
    stratum: 'contradicted',
    patient: {
      given: 'Wilhelmina36',
      family: 'Abernathy771',
      gender: 'female',
      birthDate: '1949-01-17',
      city: 'Madison',
      state: 'WI',
    },
    prescriber: { given: 'Imani73', family: 'Castellanos618' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-16T11:05:00Z',
    serviceDate: '2026-09-25',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [OSA],
    notes: [
      {
        key: 'study',
        description: 'Sleep study report',
        date: '2026-06-22',
        text: [
          'In-lab polysomnography, 2026-06-22.',
          'Total sleep time 5.8 hours. Apnea-hypopnea index (AHI) 9 events per hour.',
          'Lowest oxygen saturation 88 percent.',
          'Impression: mild obstructive sleep apnea.',
        ].join('\n'),
      },
      {
        ...e0601PrescriberNote,
        date: '2026-09-09',
        text: e0601PrescriberNote.text.replace('2026-09-10', '2026-09-09'),
      },
    ],
    labels: {
      'e0601-osa-diagnosis': met('osa', 'study'),
      'e0601-ahi-threshold': notMet('study'),
      'e0601-conservative-trial': met('visit'),
      'e0601-prescriber-order': met('visit'),
    },
  },
  {
    hcpcs: 'E0601',
    stratum: 'ambiguous',
    patient: {
      given: 'Cornelius12',
      family: 'Vasquez904',
      gender: 'male',
      birthDate: '1951-08-08',
      city: 'Lansing',
      state: 'MI',
    },
    prescriber: { given: 'Tomas88', family: 'Lindqvist204' },
    plan: 'cbk-ma-standard',
    priority: 'stat',
    created: '2026-09-17T16:30:00Z',
    serviceDate: '2026-09-22',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [OSA],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        text: [
          'Reports loud snoring and morning headaches.',
          'He says a sleep study at another clinic a few years back "showed some apnea, maybe moderate".',
          'That report is not available to me and I could not confirm the number.',
          'Positional therapy with a positional belt for 30 days in August did not help.',
          'Order: CPAP device, auto-titrating, pressure range 5 to 15 cm H2O.',
          'Order signed electronically by the prescriber.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0601-osa-diagnosis': met('osa'),
      'e0601-ahi-threshold': insufficient('visit'),
      'e0601-conservative-trial': met('visit'),
      'e0601-prescriber-order': met('visit'),
    },
  },
  {
    hcpcs: 'E0601',
    stratum: 'administrative',
    patient: {
      given: 'Leocadia90',
      family: 'Brennan418',
      gender: 'female',
      birthDate: '1956-12-03',
      city: 'Peoria',
      state: 'IL',
    },
    prescriber: { given: 'Imani73', family: 'Castellanos618' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-18T10:10:00Z',
    serviceDate: '2026-09-29',
    coverageEnd: LAPSED_ON,
    diagnoses: [OSA],
    notes: [e0601StudyStrong, e0601PrescriberNote],
    labels: {
      'e0601-osa-diagnosis': met('osa', 'study'),
      'e0601-ahi-threshold': met('study'),
      'e0601-conservative-trial': met('visit'),
      'e0601-prescriber-order': met('visit'),
    },
  },
];

// --- E0470: bi-level respiratory assist device without backup rate -----------

const e0470Study: NoteSpec = {
  key: 'study',
  description: 'Sleep study report',
  date: '2026-04-15',
  text: [
    'Split-night polysomnography, 2026-04-15.',
    'Diagnostic portion: apnea-hypopnea index (AHI) 42 events per hour.',
    'Impression: severe obstructive sleep apnea.',
  ].join('\n'),
};

const e0470CpapTrial: NoteSpec = {
  key: 'trial',
  description: 'Prescriber note on the CPAP trial',
  date: '2026-08-20',
  text: [
    'CPAP at 14 cm H2O used from 2026-05-01 to 2026-08-15, 107 days.',
    'Download shows residual AHI 21 events per hour and mask leak; she cannot exhale against the',
    'pressure and wakes repeatedly. In my judgement CPAP has not been tolerated.',
  ].join('\n'),
};

const e0470Titration: NoteSpec = {
  key: 'titration',
  description: 'Bi-level titration study',
  date: '2026-09-03',
  text: [
    'Bi-level titration, 2026-09-03.',
    'At inspiratory 16 / expiratory 10 cm H2O the residual AHI was 3 events per hour with no',
    'arousals from leak. Order: bi-level device without backup rate at 16/10 cm H2O.',
  ].join('\n'),
};

const e0470: readonly ScenarioSpec[] = [
  {
    hcpcs: 'E0470',
    stratum: 'all-met-structured',
    patient: {
      given: 'Marisol25',
      family: 'Haddad583',
      gender: 'female',
      birthDate: '1954-02-21',
      city: 'Fort Wayne',
      state: 'IN',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-14T12:00:00Z',
    serviceDate: '2026-09-23',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [{ ...OSA, onset: '2026-04-15' }],
    notes: [e0470Study, e0470CpapTrial, e0470Titration],
    labels: {
      'e0470-osa-diagnosis': met('osa', 'study'),
      'e0470-cpap-failure': met('trial'),
      'e0470-ahi-threshold': met('study'),
      'e0470-bilevel-titration': met('titration'),
    },
  },
  {
    hcpcs: 'E0470',
    stratum: 'all-met-narrative',
    patient: {
      given: 'Ignatius64',
      family: 'Oyelaran127',
      gender: 'male',
      birthDate: '1950-10-30',
      city: 'Akron',
      state: 'OH',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-15T09:30:00Z',
    serviceDate: '2026-09-24',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [
      {
        key: 'copd',
        icd10cm: 'J44.9',
        display: 'Chronic obstructive pulmonary disease, unspecified',
        onset: '2018-03-11',
      },
    ],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        date: '2026-09-08',
        text: [
          'His sleep study in March, done here on the eleventh, counted thirty-seven obstructive events',
          'an hour, so obstructive sleep apnea on top of his lung disease.',
          'He put in a solid three months on CPAP from April through June and hated every night of it;',
          'he pulls the mask off within the hour and his machine still logs over twenty events an hour.',
          'I do not think he can tolerate CPAP.',
          'Last week we tried bi-level pressure in the lab: at 15 over 9 the events dropped to a couple',
          'an hour and he slept through. I am ordering bi-level at those settings, no backup rate.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0470-osa-diagnosis': met('visit'),
      'e0470-cpap-failure': met('visit'),
      'e0470-ahi-threshold': met('visit'),
      'e0470-bilevel-titration': met('visit'),
    },
  },
  {
    hcpcs: 'E0470',
    stratum: 'one-missing',
    patient: {
      given: 'Philippa19',
      family: 'Grunewald846',
      gender: 'female',
      birthDate: '1952-05-05',
      city: 'Toledo',
      state: 'OH',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-plus',
    priority: 'stat',
    created: '2026-09-16T15:45:00Z',
    serviceDate: '2026-09-21',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [{ ...OSA, onset: '2026-04-15' }],
    notes: [e0470Study, e0470CpapTrial],
    labels: {
      'e0470-osa-diagnosis': met('osa', 'study'),
      'e0470-cpap-failure': met('trial'),
      'e0470-ahi-threshold': met('study'),
      'e0470-bilevel-titration': insufficient(),
    },
  },
  {
    hcpcs: 'E0470',
    stratum: 'contradicted',
    patient: {
      given: 'Benedikt83',
      family: 'Achterberg69',
      gender: 'male',
      birthDate: '1948-07-23',
      city: 'Evansville',
      state: 'IN',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-17T10:15:00Z',
    serviceDate: '2026-09-28',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [{ ...OSA, onset: '2026-04-15' }],
    notes: [
      e0470Study,
      {
        key: 'trial',
        description: 'Prescriber note on the CPAP trial',
        date: '2026-08-20',
        text: [
          'CPAP at 12 cm H2O used from 2026-08-06 to 2026-08-16, 10 days.',
          'He found the mask uncomfortable and asks to move to bi-level now.',
        ].join('\n'),
      },
      e0470Titration,
    ],
    labels: {
      'e0470-osa-diagnosis': met('osa', 'study'),
      'e0470-cpap-failure': notMet('trial'),
      'e0470-ahi-threshold': met('study'),
      'e0470-bilevel-titration': met('titration'),
    },
  },
  {
    hcpcs: 'E0470',
    stratum: 'ambiguous',
    patient: {
      given: 'Esperanza57',
      family: 'Lindgren223',
      gender: 'female',
      birthDate: '1955-09-12',
      city: 'Kalamazoo',
      state: 'MI',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-18T13:40:00Z',
    serviceDate: '2026-09-30',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [{ ...OSA, onset: '2026-04-15' }],
    notes: [
      e0470Study,
      {
        key: 'trial',
        description: 'Prescriber note on the CPAP trial',
        text: [
          'She may have tried a CPAP machine for a while at some point; the family were not sure when',
          'or for how long, and no download is available. Possibly did not get on with it.',
        ].join('\n'),
      },
      e0470Titration,
    ],
    labels: {
      'e0470-osa-diagnosis': met('osa', 'study'),
      'e0470-cpap-failure': insufficient('trial'),
      'e0470-ahi-threshold': met('study'),
      'e0470-bilevel-titration': met('titration'),
    },
  },
  {
    hcpcs: 'E0470',
    stratum: 'administrative',
    patient: {
      given: 'Thaddeus28',
      family: 'Moreau741',
      gender: 'male',
      birthDate: '1953-04-01',
      city: 'Cincinnati',
      state: 'OH',
    },
    prescriber: { given: 'Oren44', family: 'Sorensen312' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-18T08:05:00Z',
    serviceDate: '2026-09-29',
    coverageEnd: LAPSED_ON,
    diagnoses: [{ ...OSA, onset: '2026-04-15' }],
    notes: [e0470Study, e0470CpapTrial, e0470Titration],
    labels: {
      'e0470-osa-diagnosis': met('osa', 'study'),
      'e0470-cpap-failure': met('trial'),
      'e0470-ahi-threshold': met('study'),
      'e0470-bilevel-titration': met('titration'),
    },
  },
];

// --- K0823: group 2 power wheelchair -----------------------------------------

const MS: ConditionSpec = {
  key: 'ms',
  icd10cm: 'G35.D',
  display: 'Multiple sclerosis, unspecified',
  onset: '2009-02-14',
};

const WEAKNESS: ConditionSpec = {
  key: 'weakness',
  icd10cm: 'M62.81',
  display: 'Muscle weakness (generalized)',
  onset: '2025-11-03',
};

const k0823Exam: NoteSpec = {
  key: 'exam',
  description: 'Mobility examination',
  date: '2026-09-02',
  text: [
    'Face-to-face mobility examination, 2026-09-02.',
    'She cannot walk from the bedroom to the bathroom without resting and has fallen twice this year;',
    'she can no longer toilet or prepare a meal without help.',
    'With a rolling walker she manages 15 feet before stopping; a walker does not resolve the limitation.',
    'Grip strength 9 kg right and 7 kg left; she cannot self-propel a manual wheelchair more than 20 feet.',
    'Vision corrected to 20/30, judgement intact, and she operated a demonstration joystick safely.',
  ].join('\n'),
};

const k0823Home: NoteSpec = {
  key: 'home',
  description: 'Home assessment',
  date: '2026-08-28',
  text: [
    'Home assessment by the supplier, 2026-08-28.',
    'Doorways 34 inches or wider, 5-foot turning space in the kitchen and bathroom, level vinyl floors,',
    'ramp at the entrance. The home accommodates a power wheelchair.',
  ].join('\n'),
};

const k0823: readonly ScenarioSpec[] = [
  {
    hcpcs: 'K0823',
    stratum: 'all-met-structured',
    patient: {
      given: 'Genevieve70',
      family: 'Kowalczyk562',
      gender: 'female',
      birthDate: '1958-12-19',
      city: 'Rockford',
      state: 'IL',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-14T15:15:00Z',
    serviceDate: '2026-09-25',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [MS, WEAKNESS],
    notes: [k0823Exam, k0823Home],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': met('home'),
      'k0823-safe-operation': met('exam'),
    },
  },
  {
    hcpcs: 'K0823',
    stratum: 'all-met-narrative',
    patient: {
      given: 'Lorcan42',
      family: 'Adeyemi338',
      gender: 'male',
      birthDate: '1947-06-06',
      city: 'Gary',
      state: 'IN',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-15T10:50:00Z',
    serviceDate: '2026-09-26',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [
      {
        key: 'knees',
        icd10cm: 'M17.0',
        display: 'Bilateral primary osteoarthritis of knee',
        onset: '2015-09-30',
      },
    ],
    notes: [
      {
        key: 'exam',
        description: 'Mobility examination',
        date: '2026-09-04',
        text: [
          'Seen at home with his daughter on the fourth.',
          'Both knees give way after a few steps, so getting to the toilet in time has become the',
          'problem of his day, and he has stopped cooking because he cannot stand at the stove.',
          'He has a cane and a walker in the hall; with either he gets as far as the kitchen door and',
          'has to sit down, so neither one fixes this.',
          'His shoulders were replaced years ago and he cannot push himself in his old manual chair',
          'past the end of the bed.',
          'He reads the paper without glasses, his judgement is sound, and he drove the demonstration',
          'chair round the living room without touching a wall.',
          'The supplier measured the house the same week: wide doorways, room to turn in every room,',
          'no rugs, no steps. A power chair will fit.',
        ].join('\n'),
      },
    ],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': met('exam'),
      'k0823-safe-operation': met('exam'),
    },
  },
  {
    hcpcs: 'K0823',
    stratum: 'one-missing',
    patient: {
      given: 'Seraphina14',
      family: 'Olawale792',
      gender: 'female',
      birthDate: '1956-01-27',
      city: 'Joliet',
      state: 'IL',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-16T09:20:00Z',
    serviceDate: '2026-09-30',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [MS, WEAKNESS],
    notes: [k0823Exam],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': insufficient(),
      'k0823-safe-operation': met('exam'),
    },
  },
  {
    hcpcs: 'K0823',
    stratum: 'contradicted',
    patient: {
      given: 'Evander55',
      family: 'Takahashi186',
      gender: 'male',
      birthDate: '1950-03-09',
      city: 'Muncie',
      state: 'IN',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-17T11:35:00Z',
    serviceDate: '2026-09-28',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [MS, WEAKNESS],
    notes: [
      k0823Exam,
      {
        key: 'home',
        description: 'Home assessment',
        date: '2026-04-10',
        text: [
          'Home assessment by the supplier, 2026-04-10.',
          'Doorways 34 inches or wider, 5-foot turning space in the kitchen and bathroom, level floors.',
          'The home accommodates a power wheelchair.',
        ].join('\n'),
      },
    ],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': notMet('home'),
      'k0823-safe-operation': met('exam'),
    },
  },
  {
    hcpcs: 'K0823',
    stratum: 'ambiguous',
    patient: {
      given: 'Ottoline23',
      family: 'Mbatha509',
      gender: 'female',
      birthDate: '1954-08-15',
      city: 'Champaign',
      state: 'IL',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-standard',
    priority: 'stat',
    created: '2026-09-18T14:00:00Z',
    serviceDate: '2026-09-23',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [MS, WEAKNESS],
    notes: [
      {
        key: 'exam',
        description: 'Mobility examination',
        date: '2026-09-05',
        text: [
          'Face-to-face mobility examination, 2026-09-05.',
          'She cannot get to the bathroom or prepare a meal without help.',
          'A walker does not resolve the limitation; she stops after 10 feet.',
          'She cannot self-propel a manual wheelchair more than 15 feet.',
          'Her vision may be deteriorating; she was unsure of the joystick at first and I am not certain',
          'she could stop reliably. Will reassess.',
        ].join('\n'),
      },
      k0823Home,
    ],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': met('home'),
      'k0823-safe-operation': insufficient('exam'),
    },
  },
  {
    hcpcs: 'K0823',
    stratum: 'administrative',
    patient: {
      given: 'Casimir77',
      family: 'Ibarra630',
      gender: 'male',
      birthDate: '1952-11-11',
      city: 'Terre Haute',
      state: 'IN',
    },
    prescriber: { given: 'Anselm31', family: 'Ferreira455' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-18T16:25:00Z',
    serviceDate: '2026-09-30',
    coverageEnd: LAPSED_ON,
    diagnoses: [MS, WEAKNESS],
    notes: [k0823Exam, k0823Home],
    labels: {
      'k0823-mobility-limitation': met('exam'),
      'k0823-cane-walker-insufficient': met('exam'),
      'k0823-manual-chair-insufficient': met('exam'),
      'k0823-home-access': met('home'),
      'k0823-safe-operation': met('exam'),
    },
  },
];

// --- E0260: semi-electric hospital bed ---------------------------------------

const HEART_FAILURE: ConditionSpec = {
  key: 'chf',
  icd10cm: 'I50.22',
  display: 'Chronic systolic (congestive) heart failure',
  onset: '2021-10-05',
};

const e0260Note: NoteSpec = {
  key: 'visit',
  description: 'Prescriber visit note',
  date: '2026-09-08',
  text: [
    'Chronic systolic heart failure, ejection fraction 25 percent.',
    'Orthopnea: she must sleep with the head of the bed raised at 45 degrees to breathe; pillows slide',
    'and she wakes short of breath. The positioning need follows from her heart failure.',
    'She needs the head raised and lowered several times a night, immediately, when she wakes',
    'breathless; she cannot work a manual crank.',
  ].join('\n'),
};

const e0260: readonly ScenarioSpec[] = [
  {
    hcpcs: 'E0260',
    stratum: 'all-met-structured',
    patient: {
      given: 'Henrietta61',
      family: 'Szabo147',
      gender: 'female',
      birthDate: '1946-04-24',
      city: 'Ann Arbor',
      state: 'MI',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-14T11:10:00Z',
    serviceDate: '2026-09-22',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [HEART_FAILURE],
    notes: [e0260Note],
    labels: {
      'e0260-positioning-need': met('visit'),
      'e0260-linked-diagnosis': met('chf', 'visit'),
      'e0260-frequent-adjustment': met('visit'),
    },
  },
  {
    hcpcs: 'E0260',
    stratum: 'all-met-narrative',
    patient: {
      given: 'Bartholomew39',
      family: 'Nwosu284',
      gender: 'male',
      birthDate: '1949-12-30',
      city: 'Grand Rapids',
      state: 'MI',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-15T16:40:00Z',
    serviceDate: '2026-09-25',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [
      {
        key: 'resp',
        icd10cm: 'J96.11',
        display: 'Chronic respiratory failure with hypoxia',
        onset: '2024-01-19',
      },
    ],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        date: '2026-09-11',
        text: [
          'His lungs are the reason for all of this: since the respiratory failure he cannot lie flat',
          'for more than a few minutes without his oxygen falling, and he has been sleeping upright in',
          'a recliner, propped at something like forty degrees.',
          'At night he needs to go up and down repeatedly, sometimes right away when he coughs, and',
          'his wife cannot turn a crank fast enough. An ordinary bed will not hold him there.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0260-positioning-need': met('visit'),
      'e0260-linked-diagnosis': met('resp', 'visit'),
      'e0260-frequent-adjustment': met('visit'),
    },
  },
  {
    hcpcs: 'E0260',
    stratum: 'one-missing',
    patient: {
      given: 'Clementine48',
      family: 'Hoffmann895',
      gender: 'female',
      birthDate: '1951-02-07',
      city: 'Flint',
      state: 'MI',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-standard',
    priority: 'normal',
    created: '2026-09-16T13:25:00Z',
    serviceDate: '2026-09-29',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [HEART_FAILURE],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        date: '2026-09-09',
        text: [
          'Chronic systolic heart failure, ejection fraction 30 percent.',
          'Orthopnea: she must sleep with the head raised at 45 degrees, which pillows cannot hold.',
          'The positioning need follows from her heart failure.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0260-positioning-need': met('visit'),
      'e0260-linked-diagnosis': met('chf', 'visit'),
      'e0260-frequent-adjustment': insufficient(),
    },
  },
  {
    hcpcs: 'E0260',
    stratum: 'contradicted',
    patient: {
      given: 'Ambrose66',
      family: 'Petrovic521',
      gender: 'male',
      birthDate: '1948-09-18',
      city: 'Saginaw',
      state: 'MI',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-17T09:55:00Z',
    serviceDate: '2026-09-28',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [HEART_FAILURE],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        date: '2026-09-10',
        text: [
          'Chronic systolic heart failure, stable.',
          'He sleeps comfortably with the head raised about 20 degrees on two pillows.',
          'The positioning need follows from his heart failure.',
          'He wants to be able to raise and lower the head several times a night without getting up,',
          'immediately when he wakes; he cannot work a manual crank.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0260-positioning-need': notMet('visit'),
      'e0260-linked-diagnosis': met('chf', 'visit'),
      'e0260-frequent-adjustment': met('visit'),
    },
  },
  {
    hcpcs: 'E0260',
    stratum: 'ambiguous',
    patient: {
      given: 'Philomena85',
      family: 'Quist433',
      gender: 'female',
      birthDate: '1953-07-02',
      city: 'Battle Creek',
      state: 'MI',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-standard',
    priority: 'stat',
    created: '2026-09-18T12:45:00Z',
    serviceDate: '2026-09-21',
    coverageEnd: COVERED_THROUGH,
    diagnoses: [HEART_FAILURE],
    notes: [
      {
        key: 'visit',
        description: 'Prescriber visit note',
        text: [
          'Chronic systolic heart failure, ejection fraction 25 percent.',
          'Orthopnea: she must sleep with the head raised at 45 degrees to breathe, which pillows cannot',
          'hold. The positioning need follows from her heart failure.',
          'Her son thinks she might need to change position at night now and then, possibly; nobody',
          'has kept track of how often, and she has not said whether a crank would do.',
        ].join('\n'),
      },
    ],
    labels: {
      'e0260-positioning-need': met('visit'),
      'e0260-linked-diagnosis': met('chf', 'visit'),
      'e0260-frequent-adjustment': insufficient('visit'),
    },
  },
  {
    hcpcs: 'E0260',
    stratum: 'administrative',
    patient: {
      given: 'Erasmus17',
      family: 'Delacroix968',
      gender: 'male',
      birthDate: '1950-05-28',
      city: 'Kokomo',
      state: 'IN',
    },
    prescriber: { given: 'Lucian90', family: 'Bergstrom376' },
    plan: 'cbk-ma-plus',
    priority: 'normal',
    created: '2026-09-18T15:30:00Z',
    serviceDate: '2026-09-30',
    coverageEnd: LAPSED_ON,
    diagnoses: [HEART_FAILURE],
    notes: [e0260Note],
    labels: {
      'e0260-positioning-need': met('visit'),
      'e0260-linked-diagnosis': met('chf', 'visit'),
      'e0260-frequent-adjustment': met('visit'),
    },
  },
];

export const SCENARIOS: readonly ScenarioSpec[] = [...e0601, ...e0470, ...k0823, ...e0260];
