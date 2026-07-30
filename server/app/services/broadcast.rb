# Everything the room sees, in one place.
module Broadcast
  module_function

  def stream_for(channel) = "room:#{channel.slug}"

  def message(m)
    ActionCable.server.broadcast(stream_for(m.channel),
      { type: "message", message: MessageSerializer.call(m) })
  end

  def run(r)
    ActionCable.server.broadcast(stream_for(r.agent_session.channel),
      { type: "run", run: { id: r.id, status: r.status,
                            user: r.agent_session.user.name,
                            input_tokens: r.input_tokens, output_tokens: r.output_tokens } })
  end

  # Steps are why a minutes-long turn is legible instead of silent.
  def step(s)
    ActionCable.server.broadcast(stream_for(s.agent_run.agent_session.channel),
      { type: "step", step: { id: s.id, run_id: s.agent_run_id, kind: s.kind,
                              label: s.label, created_at: s.created_at } })
  end
end
