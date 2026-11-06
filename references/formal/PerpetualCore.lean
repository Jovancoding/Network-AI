/-
  Network-AI Perpetual Runtime — formal model of the decision core.

  Mirrors lib/perpetual/core/index.ts (nextRunState, recordSpend,
  tighten*/applyTighten, quorumGrant, quorumActive). Core Lean 4 only (no
  Mathlib). Check with:  lean references/formal/PerpetualCore.lean

  Scope: these proofs cover this model, not every agent action. The
  specification/translation gap is the real risk; the TypeScript core is also
  property-tested, and every runtime control stays in place.
-/

namespace NetworkAI.Perpetual

/-! ## Run states (I1: an external stop always works) -/

inductive RunState where
  | active | paused | revoked | stopped
  deriving DecidableEq, Repr

inductive RunEvent where
  | grant | stop | revoke | pause | resume
  deriving DecidableEq, Repr

def nextRunState : RunState → RunEvent → RunState
  | .revoked, _ => .revoked
  | .stopped, _ => .stopped
  | _, .revoke => .revoked
  | _, .stop => .stopped
  | _, .pause => .paused
  | .paused, .resume => .active
  | s, .resume => s
  | s, .grant => s

/-- Revoked runs stay revoked whatever happens next. -/
theorem revoked_absorbing (e : RunEvent) : nextRunState .revoked e = .revoked := by
  cases e <;> rfl

/-- Stopped runs stay stopped whatever happens next. -/
theorem stopped_absorbing (e : RunEvent) : nextRunState .stopped e = .stopped := by
  cases e <;> rfl

/-- Absorbing over any sequence of events. -/
theorem terminal_absorbing_trace (s : RunState) (h : s = .revoked ∨ s = .stopped) (es : List RunEvent) :
    es.foldl nextRunState s = s := by
  induction es generalizing s with
  | nil => rfl
  | cons e es ih =>
    rcases h with rfl | rfl
    · simp only [List.foldl, revoked_absorbing]; exact ih _ (Or.inl rfl)
    · simp only [List.foldl, stopped_absorbing]; exact ih _ (Or.inr rfl)

/-- I1: one external revoke ends any run (it is revoked, or was already stopped). -/
theorem revoke_always_ends (s : RunState) :
    nextRunState s .revoke = .revoked ∨ nextRunState s .revoke = .stopped := by
  cases s <;> simp [nextRunState]

/-- A grant never reactivates a run that is not active. -/
theorem grant_never_reactivates (s : RunState) (h : s ≠ .active) : nextRunState s .grant ≠ .active := by
  cases s <;> simp_all [nextRunState]

/-- Only an operator `resume` leaves `paused` for `active`. -/
theorem paused_needs_resume (e : RunEvent) (h : nextRunState .paused e = .active) : e = .resume := by
  cases e <;> simp_all [nextRunState]

/-! ## Spend (I3: spend is never forgotten) -/

def recordSpend (prev reported : Nat) : Nat := max prev reported

theorem spend_monotone (prev reported : Nat) : prev ≤ recordSpend prev reported :=
  Nat.le_max_left prev reported

/-- Spend after any sequence of reports is at least the starting spend. -/
theorem spend_monotone_trace (prev : Nat) (reports : List Nat) : prev ≤ reports.foldl recordSpend prev := by
  induction reports generalizing prev with
  | nil => exact Nat.le_refl _
  | cons r rs ih => exact Nat.le_trans (spend_monotone prev r) (ih _)

/-! ## Tightening (I2/I3: limits only narrow) -/

/-- Scope model: tier rank and a list of granted names. -/
structure Scope where
  tier : Nat
  tools : List String
  deriving Repr

def within (inner outer : Scope) : Prop :=
  inner.tier ≤ outer.tier ∧ ∀ t, t ∈ inner.tools → t ∈ outer.tools

instance (inner outer : Scope) : Decidable (within inner outer) := by
  unfold within; exact inferInstance

structure Policy where
  scope : Scope
  ttl : Nat
  autoRenew : Bool
  ceiling : Nat
  deriving Repr

structure Delta where
  scope : Option Scope
  ttl : Option Nat
  ceiling : Option Nat
  disableRenew : Bool

def scopeOk (p : Policy) : Option Scope → Bool
  | some s => decide (within s p.scope)
  | none => true

def ttlOk (p : Policy) : Option Nat → Bool
  | some t => decide (t ≤ p.ttl)
  | none => true

def ceilOk (p : Policy) : Option Nat → Bool
  | some c => decide (c ≤ p.ceiling)
  | none => true

/-- Accept only narrowing deltas; anything looser leaves the policy unchanged. -/
def applyTighten (p : Policy) (d : Delta) : Policy :=
  if scopeOk p d.scope && ttlOk p d.ttl && ceilOk p d.ceiling then
    { scope := d.scope.getD p.scope
      ttl := min (d.ttl.getD p.ttl) p.ttl
      autoRenew := if d.disableRenew then false else p.autoRenew
      ceiling := min (d.ceiling.getD p.ceiling) p.ceiling }
  else p

theorem within_refl (s : Scope) : within s s := ⟨Nat.le_refl _, fun _ h => h⟩

theorem tighten_scope_within (p : Policy) (d : Delta) : within (applyTighten p d).scope p.scope := by
  unfold applyTighten
  by_cases hok : (scopeOk p d.scope && ttlOk p d.ttl && ceilOk p d.ceiling) = true
  · rw [ite_eq_left hok]
    show within (d.scope.getD p.scope) p.scope
    cases hs : d.scope with
    | none => exact within_refl _
    | some s =>
      simp only [Bool.and_eq_true] at hok
      have h1 := hok.1.1
      rw [hs] at h1
      simpa [scopeOk, Option.getD] using h1
  · rw [ite_eq_right hok]; exact within_refl _

theorem tighten_ttl_le (p : Policy) (d : Delta) : (applyTighten p d).ttl ≤ p.ttl := by
  unfold applyTighten
  by_cases hok : (scopeOk p d.scope && ttlOk p d.ttl && ceilOk p d.ceiling) = true
  · rw [ite_eq_left hok]; exact Nat.min_le_right _ _
  · rw [ite_eq_right hok]; exact Nat.le_refl _

theorem tighten_ceiling_le (p : Policy) (d : Delta) : (applyTighten p d).ceiling ≤ p.ceiling := by
  unfold applyTighten
  by_cases hok : (scopeOk p d.scope && ttlOk p d.ttl && ceilOk p d.ceiling) = true
  · rw [ite_eq_left hok]; exact Nat.min_le_right _ _
  · rw [ite_eq_right hok]; exact Nat.le_refl _

/-- Auto-renew can be turned off by tightening, never on. -/
theorem tighten_never_enables_renew (p : Policy) (d : Delta) (h : p.autoRenew = false) : (applyTighten p d).autoRenew = false := by
  unfold applyTighten
  by_cases hok : (scopeOk p d.scope && ttlOk p d.ttl && ceilOk p d.ceiling) = true
  · rw [ite_eq_left hok]
    show (if d.disableRenew then false else p.autoRenew) = false
    split <;> simp [h]
  · rw [ite_eq_right hok]; exact h

/-! ## Quorum (I4: grant needs k, stop needs one) -/

/-- Number of distinct allowed signers among `sigs`. -/
def validCount (sigs allowed : List Nat) : Nat := ((sigs.eraseDups).filter (fun s => allowed.contains s)).length

def quorumGrant (sigs allowed : List Nat) (k : Nat) : Bool := 1 ≤ k && k ≤ validCount sigs allowed

/-- Fewer than k distinct signers never grant, however often they sign. -/
theorem grant_needs_k_distinct (sigs allowed : List Nat) (k : Nat) (h : sigs.eraseDups.length < k) :
    quorumGrant sigs allowed k = false := by
  have hle : validCount sigs allowed ≤ sigs.eraseDups.length := List.length_filter_le _ _
  unfold quorumGrant
  simp only [Bool.and_eq_false_iff, decide_eq_false_iff_not, Nat.not_le]
  exact Or.inr (Nat.lt_of_le_of_lt hle h)

inductive Status where
  | active | inactive | unknown
  deriving DecidableEq, Repr

def quorumActive (ss : List Status) : Status :=
  if ss.contains .inactive then .inactive
  else if ss.all (· == .unknown) then .unknown
  else .active

/-- Stopping needs one: a single inactive authority makes the lease inactive. -/
theorem stop_needs_one (ss : List Status) (h : Status.inactive ∈ ss) : quorumActive ss = .inactive := by
  unfold quorumActive
  simp [h]

/-- Active only if no authority says inactive. -/
theorem active_means_none_inactive (ss : List Status) (h : quorumActive ss = .active) : Status.inactive ∉ ss := by
  intro hm
  rw [stop_needs_one ss hm] at h
  exact Status.noConfusion h

end NetworkAI.Perpetual
