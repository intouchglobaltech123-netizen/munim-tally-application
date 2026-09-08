package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/kardianos/service"
)

// Windows service wrapper. The installer runs `lkp-agent install` once, then
// Windows starts the agent on boot with no arguments beyond `service`.
//
//	lkp-agent install | start | stop | uninstall
//	lkp-agent service     (invoked by the service manager)

type program struct {
	ctx    context.Context
	cancel context.CancelFunc
	cfg    opts
	log    *slog.Logger
	done   chan struct{}
}

func (p *program) Start(service.Service) error {
	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.done = make(chan struct{})
	go p.run()
	return nil
}

func (p *program) run() {
	defer close(p.done)
	if err := runWatch(p.ctx, p.cfg, p.log); err != nil {
		p.log.Error("service loop exited", "err", err)
	}
}

func (p *program) Stop(service.Service) error {
	p.cancel()
	<-p.done // let the in-flight batch finish so no cursor is lost
	return nil
}

func serviceConfig() *service.Config {
	return &service.Config{
		Name:        "MunimConnector",
		DisplayName: "Munim Tally Connector",
		Description: "Syncs Tally data to the Munim cloud. Read-only: it never writes to your books.",
	}
}

// installAndStartService registers the Windows service and starts it. It must
// run elevated; the first-run flow arranges that.
func installAndStartService(log *slog.Logger) error {
	prg := &program{log: log}
	s, err := service.New(prg, serviceConfig())
	if err != nil {
		return err
	}
	// Reinstalling over an existing service fails, so remove it first. Ignore
	// the error: on a clean machine there is nothing to remove.
	_ = service.Control(s, "stop")
	_ = service.Control(s, "uninstall")

	if err := service.Control(s, "install"); err != nil {
		return fmt.Errorf("installing service: %w", err)
	}
	if err := service.Control(s, "start"); err != nil {
		return fmt.Errorf("starting service: %w", err)
	}
	log.Info("windows service installed and started", "name", serviceConfig().Name)
	return nil
}

// runService handles the install/start/stop/uninstall verbs and the
// service-manager entry point.
func runService(action string, cfg opts, log *slog.Logger) error {
	prg := &program{cfg: cfg, log: log}
	s, err := service.New(prg, serviceConfig())
	if err != nil {
		return err
	}
	if action != "service" {
		return service.Control(s, action)
	}
	return s.Run()
}
