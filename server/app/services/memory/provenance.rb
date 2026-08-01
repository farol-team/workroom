module Memory
  # Who produced an entry and what it came from, in the words the room already
  # uses for an agent-authored message (`MessageSerializer`) — a person's name
  # and the agent that spoke for them, so "Leonid's agent" reads the same in
  # memory as it does in the transcript.
  #
  # Two stores express it differently and must not disagree. A row points at the
  # run and reads the rest through it; a context database can point at nothing
  # and has to carry the same facts inside the document it wrote. Both
  # representations are built here (Article P4).
  module Provenance
    module_function

    def of(entry)
      run = entry.source
      return { kind: entry.trust, name: entry.author_name || run.user.name, **of_run(run) } if run.is_a?(AgentRun)

      { kind: entry.trust, name: entry.author_name, agent_kind: entry.try(:agent_kind),
        model: entry.try(:model), run_id: entry.try(:run_id) }.compact
    end

    # The same facts as a document's front matter, for the store that cannot
    # point: what the run knows about itself is copied in at write time, because
    # afterwards there is nothing to ask.
    def front_matter(author:, source:, trust:)
      run = source if source.is_a?(AgentRun)
      { "trust" => trust, "author" => name_of(author) || run&.user&.name,
        "agent" => run && run.agent_session.agent_kind,
        "model" => run&.model, "run" => run&.id }.compact
    end

    def of_run(run)
      { agent_kind: run.agent_session.agent_kind, model: run.model, run_id: run.id }.compact
    end

    def name_of(author) = author.respond_to?(:name) ? author.name : author
  end
end
