# A change to a system outside this room, waiting for a person.
#
# Article P3 says memory is corrected rather than gated, and its reasoning is that
# correction is cheap. This is the case where it is not: a message that has been sent
# cannot be superseded, so the gate that memory does not need is the one an effect
# does.
#
# Three answers, not two. `discuss` is not a third ending — it leaves the proposal
# pending and open, because the honest answer to a proposal is more often "almost,
# but not like that" than yes or no, and a person forced to choose between the other
# two will pick the wrong one.
class Decision < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  belongs_to :channel
  belongs_to :agent_run, optional: true
  belongs_to :bound_capability
  belongs_to :decided_by, class_name: "User", optional: true
  belongs_to :supersedes, class_name: "Decision", optional: true

  STATES = %w[pending approved rejected superseded].freeze

  validates :state, inclusion: { in: STATES }

  scope :pending, -> { where(state: "pending") }

  def pending? = state == "pending"
  def superseded? = state == "superseded"

  # A corrected proposal arrives as another execute of the same uri: asking the agent
  # to name what it is replacing would put a mechanism in its vocabulary that it has
  # no reason to know. So the earlier one is found here rather than pointed at.
  def self.propose(capability:, args:, run:, channel:)
    earlier = pending.where(channel:, bound_capability: capability, agent_run: run).order(:id).last
    earlier&.update!(state: "superseded")

    create!(channel:, agent_run: run, bound_capability: capability,
            arguments: args || {}, supersedes: earlier)
  end

  # The three answers. Each returns false rather than raising when the decision is no
  # longer answerable — two people pressing at once is a race, and the loser of it has
  # not made a mistake.
  def approve!(by:) = settle("approved", by:)

  def reject!(by:, reason: nil) = settle("rejected", by:, reason:)

  # Not `settle`: the point of discussing is that the proposal is still there
  # afterwards. What it records is that somebody looked and said something.
  def discuss!(by:, reason: nil)
    with_lock do
      return false unless pending?

      update!(decided_by: by, reason: reason)
    end
    true
  end

  # What a person is shown. In the words of the work rather than of the API: a card
  # that says "run this?" is approved without being read, which is worse than no card.
  def describe
    { id:, state:, title: bound_capability.title,
      what: bound_capability.summary.to_s, arguments:,
      proposed_by: agent_run&.agent_session&.user&.name,
      run_id: agent_run_id, reason:, result: }
  end

  private

  # State is read and written inside one lock on the row: without it, two approvals
  # arriving together both see `pending` and the far end is called twice.
  def settle(to, by:, reason: nil)
    with_lock do
      return false unless pending?

      update!(state: to, decided_by: by, decided_at: Time.current, reason: reason || self.reason)
    end
    true
  end
end
