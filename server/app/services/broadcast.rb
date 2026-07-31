# Everything the room sees, in one place.
#
# The single decision point for audience. Callers say what happened; Broadcast
# decides who learns of it — so no caller has to remember the rule, and no
# future caller can forget it.
module Broadcast
  module_function

  def stream_for(channel) = "room:#{channel.slug}"

  # The owner's own stream. Always receives, whatever they chose to show.
  def user_stream_for(user) = "user:#{user.id}"

  def message(m)
    payload = { type: "message", message: MessageSerializer.call(m) }
    session = m.author.is_a?(AgentRun) ? m.author.agent_session : nil

    # Visibility governs an agent session, never what a person says.
    to_room(m.channel, payload) if session.nil? || session.shares_outcomes?
    to_owner(session.user, payload) if session
  end

  # Presence, at every level. Without it a private session is indistinguishable
  # from an absent colleague, which is the failure the design turns on.
  def run(r)
    payload = { type: "run", run: { id: r.id, status: r.status,
                                    user: r.agent_session.user.name,
                                    visibility: r.agent_session.visibility,
                                    input_tokens: r.input_tokens,
                                    output_tokens: r.output_tokens } }
    to_room(r.agent_session.channel, payload)
    to_owner(r.agent_session.user, payload)
  end

  # Process. The owner always; the room only if they chose to work in the open.
  def step(s)
    session = s.agent_run.agent_session
    payload = { type: "step", step: { id: s.id, run_id: s.agent_run_id, kind: s.kind,
                                      label: s.label, created_at: s.created_at } }
    to_room(session.channel, payload) if session.shares_process?
    to_owner(session.user, payload)
  end

  def to_room(channel, payload)  = ActionCable.server.broadcast(stream_for(channel), payload)
  def to_owner(user, payload)    = ActionCable.server.broadcast(user_stream_for(user), payload)
end
