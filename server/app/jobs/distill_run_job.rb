# Proposes what a finished run might be worth remembering.
#
# It only ever proposes. Article P3 is the article the memory design rests on:
# an agent that could write to memory directly is the failure it was written
# against — a wrong inference entering as fact, confirming itself on the next
# retrieval, unarguable within a month.
class DistillRunJob < ApplicationJob
  queue_as :default

  def perform(run_id)
    run = AgentRun.find_by(id: run_id)
    return unless run&.status == "succeeded"
    return if Promotion.exists?(source: run)

    answer = run.messages.order(:created_at).last
    return if answer.nil? || answer.body.blank?

    Promotion.create!(
      source: run,
      channel: run.agent_session.channel,
      state: "proposed",
      rationale: rationale_for(run, answer)
    )
  end

  private

  # Review should not mean re-reading the run.
  def rationale_for(run, answer)
    asked = run.trigger_message&.body
    parts = [ "Concluded in #{run.run_steps.count} step(s) by #{run.agent_session.user.name}'s agent." ]
    parts << "Asked: #{asked.truncate(160)}" if asked.present?
    parts << "Answered: #{answer.body.truncate(200)}"
    parts.join(" ")
  end
end
