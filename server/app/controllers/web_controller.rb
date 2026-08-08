# The page the room is drawn in.
#
# Served by this server, at this origin, on purpose. `config/initializers/cors.rb`
# already says why: a bearer token plus an open origin policy is any page on the
# internet acting as the person holding it. Same-origin does not mitigate that risk,
# it removes it — the browser never makes a cross-origin request, so there is nothing
# for a policy to get wrong.
class WebController < ActionController::Base
  # There is no form here and no cookie this controller reads. The page is the same
  # bytes for everybody, signed in or not.
  skip_forgery_protection

  # Built by `pnpm build:web` in the client's own tree (#299). Not copied into
  # `public/`: two copies of a bundle is one of them being stale, and which one is
  # served would depend on the order somebody ran two commands in.
  BUNDLE = Rails.root.join("..", "desktop", "dist-web").expand_path

  def show
    page = BUNDLE.join("index.html")
    # Said plainly rather than as a 500. A server running without a bundle is a
    # deployment that skipped a step, and the person reading this is the one who can
    # fix it.
    return render(plain: "The web client is not built here. Run `pnpm build:web`.",
                  status: :not_found) unless page.exist?

    # `no-store`: the document names the hashed asset files, so a cached one points
    # at a build that is gone. The assets themselves are content-addressed and
    # cached hard by the file server.
    response.headers["Cache-Control"] = "no-store"
    render html: page.read.html_safe, layout: false
  end
end
