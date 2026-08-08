# A turn is minutes; a request is not.
#
# The desktop client does this by holding the run open on somebody's laptop and
# posting steps back. A browser cannot: the tab may close, and the turn should not
# stop because it did. So a hosted turn is enqueued, and the room follows it the way
# it already follows every other one — through the socket, which is what Article S2
# made the source of truth about a running turn.
class HostedTurnJob < ApplicationJob
  queue_as :default

  # Entered explicitly. A job runs outside a request, so nothing has set the
  # workspace, and row-level security refuses everything until something does — which
  # is the boundary working, not a bug to route around.
  def perform(run_id)
    run = AgentRun.unscoped { AgentRun.find_by(id: run_id) }
    return unless run

    Workspace.entered(run.workspace) { Turn::Run.new(run).call }
  end
end
