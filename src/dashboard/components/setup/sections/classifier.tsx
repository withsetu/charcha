import * as React from 'react'
import { TriangleAlertIcon } from 'lucide-react'

import type { ClassifierState, ClassifierStatus } from '../../../api'
import { formatAge, formatExact, isoInstant } from '../../../format'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Badge } from '../../../ui/badge'
import { DOCS, Off, On, OutboundLink, Section } from '../primitives'

/**
 * How many neurons a day Workers AI gives away, on Free *and* Paid.
 *
 * Quoted at the one place an owner is being asked to add the binding, because "will this
 * start costing me money" is the question that otherwise stops them — and the honest
 * answer is a citable one. Recorded with its date in CLAUDE.md's verified-facts table:
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked 2026-07-23),
 * alongside ~1,075 neurons per million input tokens for the embedding model this layer
 * uses, which is what makes the allowance so much larger than a blog's comments.
 */
const FREE_NEURONS_PER_DAY = '10,000'

/**
 * The reason token this layer writes on a comment it held (`CLASSIFIER_REASON`).
 *
 * Restated rather than imported, for the reason `SETUP_SECRETS` in ../../../api.ts gives:
 * src/spam/classifier.ts reaches `Env` and this is a separate TypeScript project. It is
 * printed with the layer's name in front because that is the shape the queue shows —
 * `runLayers` prefixes the layer before storing it (src/spam/layer.ts) — and a reader
 * told to look for `similar-to-spam` and shown `classifier: similar-to-spam` is a reader
 * who thinks they are looking at something else.
 *
 * Worded as intent rather than fact: nothing here fails if that token is renamed. The
 * Turnstile section carries the same exposure with the same reasoning.
 */
const HELD_REASON = 'classifier: similar-to-spam'

/** Running, and not judging comments yet. Neither On nor Off is true of that. */
function Learning() {
  return <Badge variant="secondary">Learning</Badge>
}

/**
 * How many more decisions of each kind the layer is waiting for, as a sentence.
 *
 * **What is missing, not a statistic, and that is #177's own instruction.** "You have 6
 * and 40" is a fact an owner has to do arithmetic on before it changes anything; "24 more
 * approvals" is the same fact with the arithmetic done and the action named. The raw
 * counts follow it in the copy as the evidence, rather than leading as the point.
 *
 * Both classes are named only when both are short, because MIN_LABELS_PER_CLASS gates
 * them independently — a site with 300 spam decisions and 4 approvals is waiting on
 * approvals alone, and a sentence listing both would send its owner looking for spam that
 * is not the thing holding this up.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function remainingSentence(report: ClassifierStatus): string {
  const ham = Math.max(0, report.minPerClass - report.hamCount)
  const spam = Math.max(0, report.minPerClass - report.spamCount)
  const parts: string[] = []
  if (ham > 0) parts.push(`${String(ham)} more ${plural(ham, 'approval')}`)
  if (spam > 0) parts.push(`${String(spam)} more ${plural(spam, 'spam decision')}`)
  return parts.join(' and ')
}

/**
 * A noun that agrees with the count in front of it, and the count-and-noun together.
 *
 * Two one-line helpers rather than four inline ternaries, because the copy read "The 1
 * approvals" in the one state nobody had run: a deployment is in `model-changed` from its
 * *first* decision — src/spam/train.ts writes the row then — so one is an ordinary number
 * here rather than an edge case.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`
}

function countOf(n: number, noun: string): string {
  return `${String(n)} ${plural(n, noun)}`
}

/**
 * The counts, as the sentence that says whose decisions they are.
 *
 * "You approved 41 and marked 38 as spam" rather than "41 ham, 38 spam". They are the
 * owner's own decisions replayed back at them, which is the one thing about this layer
 * that makes it different from the six rules above it — and the wording is where that
 * shows.
 */
function decisionsSoFar(report: ClassifierStatus): string {
  return `approved ${String(report.hamCount)} and marked ${String(report.spamCount)} as spam`
}

/**
 * When the model last learned something, as a `<time>` a moderator can hover.
 *
 * **It is the only symptom a classifier that stopped training has.** Nothing else changes
 * when training starts failing — decisions still succeed, the queue still moves, the
 * counts simply stop. `formatAge` is the queue's own formatter, so "3 days ago" here
 * means what it means on a comment card; the `title` and `dateTime` carry the instant for
 * anyone who needs to compare it with a deploy.
 */
function LastLearned({ at }: { at: number }) {
  return (
    <time dateTime={isoInstant(at)} title={formatExact(at)}>
      {formatAge(at, Math.floor(Date.now() / 1000))}
    </time>
  )
}

/**
 * Layer 7, and the states that used to look identical from this screen (#177).
 *
 * **Three of the four are a layer abstaining, and they need different things from the
 * owner** — a binding, more moderating, and a retrain that the next decision does by
 * itself. The fourth is it working, which looked the same as all three of them. Until
 * this section the only difference between any of them was one `announceOnce` line per
 * isolate, in a log an owner would have to be tailing to see. That is the failure
 * CLAUDE.md names by hand: a layer that quietly stops working is invisible without
 * instrumentation, and a self-training one has a second version of it, because "the model
 * never learned anything" also has no symptom.
 *
 * **There is no score, no accuracy and no confidence, in any state.** The layer's
 * threshold is provisional and uncalibrated (#175), so any such number would be invented
 * — and a percentage on a dashboard is believed. What the data honestly supports is
 * counts, the gate they are counted against, whether the binding exists, and when the
 * model last learned. There is also no progress bar: a meter is a statistic wearing a
 * shape, and the sentence this section leads with is the number an owner can act on.
 *
 * **It reports and it never writes.** The `spam_model` row is written by exactly one
 * thing — a human moderation decision (src/spam/train.ts) — which is the whole of #28's
 * answer to what counts as a label, so there is deliberately no reset, no retrain and no
 * seed control here. The only control this feature has is the queue.
 *
 * **Sixteen paragraphs became four, one per state (#216).** This section shipped hours
 * before that issue was written and got the same treatment as the rest of the tab: the
 * section's own preamble went, because each state now opens by saying what the layer is
 * doing, and every argument for the design — why it abstains cold, why a false positive
 * on a person's writing is different from one on a rule, what an embedding costs — is on
 * charcha.dev, which is also where the section's link goes.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function ClassifierSection({ report }: { report: ClassifierStatus }) {
  const State = BODIES[report.state]
  return (
    <Section title="Spam classifier" status={BADGES[report.state]}>
      <State report={report} />
    </Section>
  )
}

/**
 * The badge each state wears — four states, three words.
 *
 * A map rather than a nested ternary because the interesting fact is the collision: two
 * different states both read `Off`, and they are the two where *nothing is running*. In a
 * ternary chain that is a fall-through nobody would notice; here it is a line you can see.
 *
 * `Record<ClassifierState, …>` rather than an object literal, so a fifth state added on
 * the Worker's side fails to typecheck here instead of rendering no badge at all.
 */
const BADGES: Record<ClassifierState, React.ReactNode> = {
  trained: <On />,
  learning: <Learning />,
  'model-changed': <Off />,
  'no-binding': <Off />,
}

/** The body each state renders, keyed the same way and for the same reason. */
const BODIES: Record<ClassifierState, (props: { report: ClassifierStatus }) => React.JSX.Element> =
  {
    trained: Trained,
    learning: LearningState,
    'model-changed': ModelChanged,
    'no-binding': NoBinding,
  }

/** How every state ends: the page that now carries what this section used to explain. */
function Why() {
  return <OutboundLink href={DOCS.classifier}>How it learns, and what it costs</OutboundLink>
}

function Trained({ report }: { report: ClassifierStatus }) {
  return (
    <p>
      It is judging comments, and it learned how from you: you have {decisionsSoFar(report)}
      {report.updatedAt !== null && (
        <>
          , most recently <LastLearned at={report.updatedAt} />
        </>
      )}
      . <b>Holding is the most it can ever do</b> — it can never refuse a comment, and one it holds
      carries <code>{HELD_REASON}</code> beside it in the queue.{' '}
      {report.updatedAt !== null && (
        <>If that date stops moving while you are still moderating, training has stopped. </>
      )}
      <Why />.
    </p>
  )
}

function LearningState({ report }: { report: ClassifierStatus }) {
  const nothingYet = report.hamCount === 0 && report.spamCount === 0

  return (
    <p>
      {nothingYet
        ? 'It has not learned anything yet. '
        : `So far you have ${decisionsSoFar(report)}. `}
      It starts holding comments once you have approved {report.minPerClass} and marked{' '}
      {report.minPerClass} as spam, counted separately — <b>{remainingSentence(report)}</b> to go.
      Until then it abstains rather than guessing. <b>Only Approve and Spam teach it</b>, in the
      queue; Delete does not. <Why />.
    </p>
  )
}

function ModelChanged({ report }: { report: ClassifierStatus }) {
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>What it learned was fitted with a different embedding model</AlertTitle>
      <AlertDescription>
        <p>
          This deployment now turns comments into numbers with a different model than the one its
          stored weights were fitted with, so it abstains rather than reading them as though they
          meant the same thing. Your next Approve or Spam starts a fresh model: the{' '}
          {countOf(report.hamCount, 'approval')} and {countOf(report.spamCount, 'spam decision')}{' '}
          behind the old one are <b>not carried over</b>, so it will go quiet again until you have{' '}
          {report.minPerClass} of each. Comments arrive and are held exactly as they are now.{' '}
          <Why />.
        </p>
      </AlertDescription>
    </Alert>
  )
}

function NoBinding({ report }: { report: ClassifierStatus }) {
  const trainedSomething = report.hamCount > 0 || report.spamCount > 0

  return (
    <p>
      This deployment has <b>no Workers AI binding</b>, so this layer never runs: no comment is
      checked against it, and no decision you make trains it. Nothing else is affected.{' '}
      {trainedSomething && (
        <>
          You had {decisionsSoFar(report)} before that, and those decisions are <b>still stored</b>,
          so it carries on from them if the binding comes back.{' '}
        </>
      )}
      Add it at <b>Workers &amp; Pages</b> → your Worker → <b>Bindings</b> → <b>Add</b> →{' '}
      <b>Workers AI</b>, with the variable name <code>AI</code>, then <b>Deploy</b>. It is free to
      have: {FREE_NEURONS_PER_DAY} neurons a day on the free plan, and the inference runs in your
      own Cloudflare account. <Why />.
    </p>
  )
}
