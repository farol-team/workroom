# Everything the room sees, in one place.
#
# Working in a channel is already the decision to share, so there is nothing to
# configure. Two audiences, fixed: the room gets outcomes, the owner also gets
# the process behind them.
module Broadcast
  module_function

  def stream_for(channel)  = "room:#{channel.slug}"
  def user_stream_for(user) = "user:#{user.id}"

  def message(m)
    payload = { type: "message", message: MessageSerializer.call(m) }
    to_room(m.channel, payload)
    to_owner(m.author.agent_session.user, payload) if m.author.is_a?(AgentRun)
    elsewhere(m)
  end

  # A client is subscribed to the room it has open and to nothing else, so
  # without this an unread badge could only be computed at the moment somebody
  # opens the very channel it was meant to save them opening.
  #
  # It carries no content: what happened is the room's business, and this is
  # only the news that something did.
  def elsewhere(m)
    author = m.author.is_a?(User) ? m.author : m.author.agent_session.user
    m.channel.memberships.includes(:user).each do |membership|
      next if membership.user == author

      to_owner(membership.user, { type: "elsewhere", channel: m.channel.slug })
    end
  end

  def run(r)
    payload = { type: "run", run: { id: r.id, status: r.status,
                                    user: r.agent_session.user.name,
                                    model: r.model,
                                    context_used: r.context_used,
                                    context_size: r.context_size,
                                    context_fraction: r.context_fraction,
                                    cost: r.cost } }
    to_room(r.agent_session.channel, payload)
    to_owner(r.agent_session.user, payload)
  end

  # The agent saying what it intends. Unlike the steps behind it this belongs in
  # the room — it is what a colleague reads to decide whether to wait or step in.
  # A separate method rather than a branch inside `step`, because a plan is a
  # different kind of thing with a different audience.
  def plan(s)
    payload = { type: "plan", plan: { run_id: s.agent_run_id,
                                      entries: s.payload["entries"] || [],
                                      created_at: s.created_at } }
    to_room(s.agent_run.agent_session.channel, payload)
    to_owner(s.agent_run.agent_session.user, payload)
  end

  # Work product. The room came for this.
  def artifact(a)
    to_room(a.channel, { type: "artifact",
                         artifact: { id: a.id, name: a.name, kind: a.kind,
                                     run_id: a.agent_run_id } })
  end

  # Process. Available to anyone who asks for it, never pushed at the room.
  def step(s)
    to_owner(s.agent_run.agent_session.user,
             { type: "step", step: { id: s.id, run_id: s.agent_run_id, kind: s.kind,
                                     label: s.label, created_at: s.created_at } })
  end

  def to_room(channel, payload) = ActionCable.server.broadcast(stream_for(channel), payload)
  def to_owner(user, payload)   = ActionCable.server.broadcast(user_stream_for(user), payload)
end
