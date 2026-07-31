# Writes an approved promotion into the room's memory.
#
# The content comes from the source rather than from the promotion, so the
# record of what was decided stays separate from the thing decided about.
class ApplyPromotionJob < ApplicationJob
  queue_as :default

  def perform(promotion_id)
    promotion = Promotion.find_by(id: promotion_id)
    return unless promotion&.state == "approved"

    title, detail = content_for(promotion.source)
    return if detail.blank?

    entry = Memory::Store.current.write(
      promotion.channel,
      title: title, detail: detail,
      trust: "agent",              # a distilled conclusion is an inference
      source: promotion.source,
      author: promotion.approved_by
    )

    promotion.update!(state: "applied", viking_uri: entry.uri)
    Activity.log(actor: promotion.approved_by, action: "memory.promoted",
                 subject: entry, promotion_id: promotion.id)
  end

  private

  def content_for(source)
    case source
    when AgentRun
      answer = source.messages.order(:created_at).last
      [ (source.trigger_message&.body.presence || answer&.body).to_s.truncate(120), answer&.body ]
    when Message   then [ source.body.truncate(120), source.body ]
    when Artifact  then [ source.name, "Artifact: #{source.name}" ]
    else [ "", nil ]
    end
  end
end
