class MessageSerializer
  def self.call(m)
    author =
      if m.author.is_a?(User)
        { kind: "user", id: m.author.id, name: m.author.name, email: m.author.email }
      else
        run = m.author
        { kind: "agent", id: run.id, name: run.agent_session.user.name,
          agent_kind: run.agent_session.agent_kind, run_id: run.id }
      end

    { id: m.id, channel_id: m.channel_id, parent_id: m.parent_id,
      body: m.body, author:, created_at: m.created_at }
  end
end
