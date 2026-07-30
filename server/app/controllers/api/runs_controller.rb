module Api
  # An agent turn. The client owns the agent process; the server owns the
  # record of what it did — including token counts, which are reporting,
  # never billing: the model credentials stay on the user's machine.
  class RunsController < BaseController
    def create
      channel!
      authorize_channel!
      return if performed?

      session = AgentSession.live_for(current_user, channel!).first ||
                AgentSession.create!(user: current_user, channel: channel!,
                                     agent_kind: params[:agent_kind] || "opencode",
                                     external_id: params[:external_id], status: "running",
                                     started_at: Time.current)
      session.update!(status: "running", external_id: params[:external_id].presence || session.external_id)

      run = session.agent_runs.create!(
        trigger_message_id: params[:trigger_message_id], status: "running", started_at: Time.current
      )
      Broadcast.run(run)
      render json: { id: run.id, agent_session_id: session.id }, status: :created
    end

    def update
      run = find_run
      run.update!(params.permit(:status, :input_tokens, :output_tokens).to_h.compact)
      run.update!(ended_at: Time.current) if %w[succeeded failed interrupted].include?(run.status)
      run.agent_session.update!(status: "idle") if run.ended_at
      Broadcast.run(run)
      render json: { ok: true }
    end

    def step
      run = find_run
      s = run.run_steps.create!(kind: params.require(:kind), label: params[:label],
                                payload: params[:payload] || {})
      Broadcast.step(s)
      render json: { ok: true }
    end

    def message
      run = find_run
      m = run.agent_session.channel.messages.create!(
        author: run, body: params.require(:body), parent_id: run.trigger_message_id
      )
      Broadcast.message(m)
      render json: MessageSerializer.call(m), status: :created
    end

    private

    def find_run
      AgentRun.joins(:agent_session).where(agent_sessions: { user_id: current_user.id }).find(params[:id])
    end
  end
end
