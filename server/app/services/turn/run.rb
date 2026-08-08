module Turn
  # A turn, executed on this server.
  #
  # The desktop agent has a folder, a shell and a git history because a laptop has
  # those. A browser has none of them (#299), so this is not that agent moved to a
  # server — its entire capability surface is the rail: two tools, one channel,
  # scoped to one person. There is no filesystem to escape and no process to
  # contain, which is why this card needed no sandbox.
  #
  # What is left to contain is already contained: the rail is one channel's (#297), a
  # capability that changes something outside is proposed rather than run (#302), and
  # row-level security is the boundary between workspaces.
  class Run
    # A turn that will not stop is a bill nobody agreed to. Reached, it ends the turn
    # the same way any other ending does — said in the room, not swallowed.
    ROUNDS = 12

    def initialize(agent_run)
      @run = agent_run
      @channel = agent_run.agent_session.channel
      @user = agent_run.agent_session.user
      @rail = Rail::Registry.new(channel: @channel, user: @user)
    end

    def call
      credential = UserCredential.find_by(user: @user, provider: "anthropic")
      return finish("failed", "There is no model key for this account yet. " \
                              "Add one in settings and ask again.") unless credential

      converse(Model.new(credential: credential.secret, model: @run.model))
    rescue Model::Refused => e
      # News about the provider, not a fault in the room. Said out loud because a
      # turn that stopped for a reason nobody can see is the failure #94 describes.
      finish("failed", "The turn could not run: #{e.message}")
    end

    private

    def converse(model)
      messages = [ { role: "user", content: opening } ]

      ROUNDS.times do
        answer = model.call(messages:, tools: @rail.descriptors, system: system_prompt)
        record_usage(answer)

        return finish("succeeded", answer.text) if answer.tool_calls.empty?

        messages << { role: "assistant", content: assistant_blocks(answer) }
        messages << { role: "user", content: answer.tool_calls.map { |c| run_tool(c) } }
      end

      finish("failed", "The turn went round #{ROUNDS} times without finishing, and was stopped.")
    end

    # A tool call, performed and recorded. Two steps rather than one: what was asked
    # and what came back are different facts, and a turn that shows only the second
    # is one nobody can follow (Article S2).
    def run_tool(call)
      step("tool_use", call[:name], { uri: call.dig(:args, "uri"), query: call.dig(:args, "query") }.compact)

      status, said = perform(call)

      step("tool_result", call[:name], { ok: status == :ok })
      { type: "tool_result", tool_use_id: call[:id], content: said.to_s,
        is_error: status != :ok }
    end

    # The rail's two, and nothing else. A name that is not one of them is an answer
    # rather than a crash: a model that invented a tool should be told so and given
    # the chance to stop inventing it.
    def perform(call)
      args = call[:args] || {}
      case call[:name]
      when "search_capabilities" then [ :ok, @rail.search(args["query"].to_s).to_json ]
      when "execute_capability"  then @rail.execute(args["uri"].to_s, args["args"] || {})
      else [ :error, "there is no tool called #{call[:name]}" ]
      end
    end

    def step(kind, label, payload)
      recorded = @run.run_steps.create!(kind:, label:, payload:)
      Broadcast.step(recorded)
      recorded
    end

    # The room hears the answer; the run's row says it ended. Both, in one place, so
    # a turn cannot end without the room being told (#94).
    def finish(status, text)
      body = text.to_s.strip.presence || "The turn finished without anything to say."
      message = @channel.messages.create!(author: @run, body:)
      @run.update!(status:, ended_at: Time.current)
      @run.agent_session.update!(status: "idle")
      Broadcast.message(message)
      Broadcast.run(@run)
      message
    end

    def record_usage(answer)
      used = answer.usage || {}
      @run.update!(input_tokens: used["input_tokens"], output_tokens: used["output_tokens"],
                   total_tokens: used.values_at("input_tokens", "output_tokens").compact.sum)
    end

    def assistant_blocks(answer)
      text = answer.text.presence
      [ ({ type: "text", text: text } if text),
        *answer.tool_calls.map { |c| { type: "tool_use", id: c[:id], name: c[:name], input: c[:args] } } ].compact
    end

    def opening = @run.trigger_message&.body.presence || "Carry on with the work in this channel."

    # Deliberately short. What this agent should know about the room it is in comes
    # from the rail — asked for when needed, not pasted in ahead of time — which is
    # the whole reason the rail exists: the tool surface stays at two however many
    # capabilities the channel has, and a session is not charged for what it never
    # uses.
    def system_prompt
      <<~TEXT
        You are working in the "#{@channel.name}" channel of a shared workspace,
        alongside the people in it. #{@channel.purpose.presence}

        Everything this channel knows — what the team has learned, how it works here,
        and the systems it can reach — is behind `search_capabilities`. Look before
        answering from memory; the room's own record is better than your guess about it.

        Some capabilities change things outside this room. Asking for one does not do
        it: a person in the channel decides, and you will be told it is waiting. Say
        what you proposed and carry on with whatever does not depend on the answer.

        Answer as a colleague would — plainly, and in the words of the work.
      TEXT
    end
  end
end
