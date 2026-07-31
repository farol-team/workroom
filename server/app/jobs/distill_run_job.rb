# Writes what a finished run concluded into the channel's memory.
#
# Article P3 as amended: no approval step. The person is in the room to work,
# and a knowledge base that must be curated does not get curated. What keeps it
# safe is that correction is cheap — provenance is mandatory, and an entry is
# changed by superseding it.
class DistillRunJob < ApplicationJob
  queue_as :default

  def perform(run_id)
    run = AgentRun.find_by(id: run_id)
    return unless run&.status == "succeeded"
    return if MemoryEntry.exists?(source: run)

    answer = run.messages.order(:created_at).last
    return if answer.nil? || answer.body.blank?

    Memory::Store.current.write(
      run.agent_session.channel,
      title: (run.trigger_message&.body.presence || answer.body).truncate(120),
      detail: answer.body,
      trust: "agent",
      source: run,
      key: "run-#{run.id}"
    )
  end
end
